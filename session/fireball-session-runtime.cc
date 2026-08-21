#include <gst/gst.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <unistd.h>

namespace {

constexpr const char* kInternalHome = "file:///usr/share/fireball-session/home.html";
constexpr std::size_t kMaximumTabs = 4;
constexpr std::size_t kMaximumUrlBytes = 4096;

struct Configuration {
  int width = 1280;
  int height = 720;
  int fps = 15;
  int bitrate = 3000000;
  std::string initial_tab_id;
  std::string initial_url;
  std::string stun_server;
  std::string turn_servers;
  std::string ice_policy = "all";
};

struct AudioBranch {
  GstPad* source_pad = nullptr;
  GstPad* mixer_pad = nullptr;
  std::vector<GstElement*> elements;
};

struct Tab {
  std::string id;
  std::string url;
  GstElement* source = nullptr;
  GstElement* mixer = nullptr;
  std::vector<GstElement*> fixed_elements;
  GstPad* video_selector_pad = nullptr;
  GstPad* audio_selector_pad = nullptr;
  gulong pad_added_handler = 0;
  gulong pad_removed_handler = 0;
  std::vector<std::unique_ptr<AudioBranch>> audio_branches;
};

class Runtime;

struct PadDispatch {
  Runtime* runtime;
  GstElement* source;
  GstPad* pad;
  bool added;
};

class Runtime {
 public:
  explicit Runtime(Configuration configuration) : configuration_(std::move(configuration)) {}

  ~Runtime() {
    if (input_watch_id_) g_source_remove(input_watch_id_);
    if (bus_watch_id_) g_source_remove(bus_watch_id_);
    if (video_selector_) g_object_set(video_selector_, "active-pad", nullptr, nullptr);
    if (audio_selector_) g_object_set(audio_selector_, "active-pad", nullptr, nullptr);
    for (auto& [id, tab] : tabs_) {
      (void)id;
      DestroyTabElements(*tab);
    }
    tabs_.clear();
    if (video_selector_) gst_object_unref(video_selector_);
    if (audio_selector_) gst_object_unref(audio_selector_);
    if (pipeline_) {
      gst_element_set_state(pipeline_, GST_STATE_NULL);
      gst_object_unref(pipeline_);
    }
    if (loop_) g_main_loop_unref(loop_);
  }

  bool Initialize(std::string* error) {
    GError* parse_error = nullptr;
    pipeline_ = gst_parse_launch(
        "input-selector name=video_selector sync-streams=true sync-mode=clock "
        "cache-buffers=true drop-backwards=true ! queue leaky=downstream max-size-buffers=2 ! "
        "video/x-raw,format=BGRA ! videoconvert ! videoscale ! videorate ! "
        "capsfilter name=video_caps ! openh264enc name=video_encoder usage-type=screen "
        "rate-control=bitrate complexity=low enable-frame-skip=true ! h264parse config-interval=-1 ! "
        "video/x-h264,profile=constrained-baseline ! webrtcsink name=rtc "
        "video-caps=video/x-h264 enable-control-data-channel=true run-signalling-server=true "
        "signalling-server-host=127.0.0.1 signalling-server-port=8443 run-web-server=false "
        "meta=meta,name=fireball-session "
        "input-selector name=audio_selector sync-streams=true sync-mode=clock "
        "cache-buffers=true drop-backwards=true ! queue max-size-buffers=8 ! audioconvert ! "
        "audioresample ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! "
        "opusenc bitrate=64000 ! rtc.",
        &parse_error);
    if (!pipeline_ || parse_error) {
      *error = parse_error ? parse_error->message : "pipeline parse failed";
      if (parse_error) g_error_free(parse_error);
      if (pipeline_) {
        gst_object_unref(pipeline_);
        pipeline_ = nullptr;
      }
      return false;
    }

    video_selector_ = gst_bin_get_by_name(GST_BIN(pipeline_), "video_selector");
    audio_selector_ = gst_bin_get_by_name(GST_BIN(pipeline_), "audio_selector");
    GstElement* video_caps = gst_bin_get_by_name(GST_BIN(pipeline_), "video_caps");
    GstElement* encoder = gst_bin_get_by_name(GST_BIN(pipeline_), "video_encoder");
    GstElement* rtc = gst_bin_get_by_name(GST_BIN(pipeline_), "rtc");
    if (!video_selector_ || !audio_selector_ || !video_caps || !encoder || !rtc) {
      *error = "pipeline is missing a required element";
      if (video_caps) gst_object_unref(video_caps);
      if (encoder) gst_object_unref(encoder);
      if (rtc) gst_object_unref(rtc);
      return false;
    }

    GstCaps* caps = gst_caps_new_simple(
        "video/x-raw", "format", G_TYPE_STRING, "I420", "width", G_TYPE_INT,
        configuration_.width, "height", G_TYPE_INT, configuration_.height,
        "framerate", GST_TYPE_FRACTION, configuration_.fps, 1, nullptr);
    g_object_set(video_caps, "caps", caps, nullptr);
    gst_caps_unref(caps);
    g_object_set(encoder, "gop-size", configuration_.fps * 2, "bitrate", configuration_.bitrate, nullptr);
    if (!SetRtcProperty(rtc, "stun-server", configuration_.stun_server, error)
        || !SetRtcProperty(rtc, "ice-transport-policy", configuration_.ice_policy, error)
        || (!configuration_.turn_servers.empty()
            && !SetRtcProperty(rtc, "turn-servers", configuration_.turn_servers, error))) {
      gst_object_unref(video_caps);
      gst_object_unref(encoder);
      gst_object_unref(rtc);
      return false;
    }
    gst_object_unref(video_caps);
    gst_object_unref(encoder);
    gst_object_unref(rtc);

    if (!CreateTab(configuration_.initial_tab_id, configuration_.initial_url, true, error)) return false;

    GstBus* bus = gst_element_get_bus(pipeline_);
    bus_watch_id_ = gst_bus_add_watch(bus, &Runtime::OnBusMessage, this);
    gst_object_unref(bus);
    loop_ = g_main_loop_new(nullptr, FALSE);
    GstStateChangeReturn state = gst_element_set_state(pipeline_, GST_STATE_PLAYING);
    if (state == GST_STATE_CHANGE_FAILURE) {
      *error = "pipeline refused PLAYING state";
      return false;
    }
    state = gst_element_get_state(pipeline_, nullptr, nullptr, 30 * GST_SECOND);
    if (state == GST_STATE_CHANGE_FAILURE) {
      *error = "pipeline failed to reach PLAYING state";
      return false;
    }
    running_ = true;
    GIOChannel* input = g_io_channel_unix_new(STDIN_FILENO);
    g_io_channel_set_encoding(input, nullptr, nullptr);
    g_io_channel_set_buffered(input, TRUE);
    input_watch_id_ = g_io_add_watch(
        input, static_cast<GIOCondition>(G_IO_IN | G_IO_HUP | G_IO_ERR), &Runtime::OnInput, this);
    g_io_channel_unref(input);
    return true;
  }

  int Run() {
    std::cout << "READY " << configuration_.initial_tab_id << std::endl;
    g_main_loop_run(loop_);
    return exit_code_;
  }

 private:
  static gboolean OnBusMessage(GstBus*, GstMessage* message, gpointer data) {
    auto* runtime = static_cast<Runtime*>(data);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
      GError* error = nullptr;
      gchar* debug = nullptr;
      gst_message_parse_error(message, &error, &debug);
      std::cerr << "fireball-session-runtime: GStreamer error: "
                << (error ? error->message : "unknown") << std::endl;
      if (error) g_error_free(error);
      g_free(debug);
      runtime->exit_code_ = 1;
      g_main_loop_quit(runtime->loop_);
    } else if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_EOS) {
      std::cerr << "fireball-session-runtime: unexpected end of stream" << std::endl;
      runtime->exit_code_ = 1;
      g_main_loop_quit(runtime->loop_);
    }
    return G_SOURCE_CONTINUE;
  }

  static gboolean OnInput(GIOChannel* channel, GIOCondition condition, gpointer data) {
    auto* runtime = static_cast<Runtime*>(data);
    if ((condition & (G_IO_HUP | G_IO_ERR)) != 0) {
      runtime->input_watch_id_ = 0;
      g_main_loop_quit(runtime->loop_);
      return G_SOURCE_REMOVE;
    }
    gchar* line = nullptr;
    gsize length = 0;
    GError* read_error = nullptr;
    GIOStatus status = g_io_channel_read_line(channel, &line, &length, nullptr, &read_error);
    if (status == G_IO_STATUS_NORMAL && line) runtime->HandleCommand(std::string(line, length));
    if (read_error) {
      std::cerr << "fireball-session-runtime: command read failed" << std::endl;
      g_error_free(read_error);
      runtime->exit_code_ = 1;
      g_main_loop_quit(runtime->loop_);
      g_free(line);
      runtime->input_watch_id_ = 0;
      return G_SOURCE_REMOVE;
    }
    g_free(line);
    return G_SOURCE_CONTINUE;
  }

  static void OnPadAdded(GstElement* source, GstPad* pad, gpointer data) {
    auto* dispatch = new PadDispatch{static_cast<Runtime*>(data),
                                    GST_ELEMENT(gst_object_ref(source)),
                                    GST_PAD(gst_object_ref(pad)), true};
    g_main_context_invoke(nullptr, &Runtime::DispatchPad, dispatch);
  }

  static void OnPadRemoved(GstElement* source, GstPad* pad, gpointer data) {
    auto* dispatch = new PadDispatch{static_cast<Runtime*>(data),
                                    GST_ELEMENT(gst_object_ref(source)),
                                    GST_PAD(gst_object_ref(pad)), false};
    g_main_context_invoke(nullptr, &Runtime::DispatchPad, dispatch);
  }

  static gboolean DispatchPad(gpointer data) {
    std::unique_ptr<PadDispatch> dispatch(static_cast<PadDispatch*>(data));
    if (dispatch->added) dispatch->runtime->AttachAudioPad(dispatch->source, dispatch->pad);
    else dispatch->runtime->DetachAudioPad(dispatch->source, dispatch->pad);
    gst_object_unref(dispatch->pad);
    gst_object_unref(dispatch->source);
    return G_SOURCE_REMOVE;
  }

  bool SetRtcProperty(GstElement* rtc, const char* property, const std::string& value,
                      std::string* error) {
    GParamSpec* specification = g_object_class_find_property(G_OBJECT_GET_CLASS(rtc), property);
    if (!specification || (specification->flags & G_PARAM_WRITABLE) == 0) {
      *error = std::string("invalid ") + property + " property";
      return false;
    }
    GValue parsed = G_VALUE_INIT;
    g_value_init(&parsed, G_PARAM_SPEC_VALUE_TYPE(specification));
    const bool valid = G_VALUE_HOLDS_STRING(&parsed)
        ? (g_value_set_string(&parsed, value.c_str()), true)
        : gst_value_deserialize(&parsed, value.c_str());
    if (!valid) {
      g_value_unset(&parsed);
      *error = std::string("invalid ") + property + " value";
      return false;
    }
    g_object_set_property(G_OBJECT(rtc), property, &parsed);
    g_value_unset(&parsed);
    return true;
  }

  GstElement* MakeElement(const char* factory, const std::string& name, std::string* error) {
    GstElement* element = gst_element_factory_make(factory, name.c_str());
    if (!element && error) *error = std::string("required GStreamer element is unavailable: ") + factory;
    return element;
  }

  bool CreateTab(const std::string& id, const std::string& url, bool activate, std::string* error) {
    if (tabs_.size() >= kMaximumTabs) {
      *error = "TAB_LIMIT_REACHED";
      return false;
    }
    if (!ValidUuid(id) || tabs_.contains(id) || !ValidUrl(url)) {
      *error = "TAB_INPUT_INVALID";
      return false;
    }
    auto tab = std::make_unique<Tab>();
    tab->id = id;
    tab->url = url;
    const std::string suffix = std::to_string(next_element_id_++);
    tab->source = MakeElement("wpesrc", "tab_source_" + suffix, error);
    tab->mixer = MakeElement("audiomixer", "tab_mixer_" + suffix, error);
    if (!tab->source || !tab->mixer) {
      ReleaseDetachedTabElements(*tab);
      return false;
    }
    const std::vector<std::pair<const char*, std::string>> fixed = {
        {"audiotestsrc", "tab_silence_" + suffix},
        {"queue", "tab_silence_queue_" + suffix},
        {"audioconvert", "tab_silence_convert_" + suffix},
        {"audioresample", "tab_silence_resample_" + suffix},
        {"capsfilter", "tab_silence_caps_" + suffix},
        {"queue", "tab_output_queue_" + suffix},
        {"audioconvert", "tab_output_convert_" + suffix},
        {"audioresample", "tab_output_resample_" + suffix},
        {"capsfilter", "tab_output_caps_" + suffix},
    };
    for (const auto& [factory, name] : fixed) {
      GstElement* element = MakeElement(factory, name, error);
      if (!element) {
        ReleaseDetachedTabElements(*tab);
        return false;
      }
      tab->fixed_elements.push_back(element);
    }

    g_object_set(tab->source, "location", url.c_str(), nullptr);
    g_object_set(tab->fixed_elements[0], "wave", 4, "is-live", TRUE, "do-timestamp", TRUE, nullptr);
    GstCaps* audio_caps = gst_caps_new_simple(
        "audio/x-raw", "format", G_TYPE_STRING, "S16LE", "rate", G_TYPE_INT,
        48000, "channels", G_TYPE_INT, 2, nullptr);
    g_object_set(tab->fixed_elements[4], "caps", audio_caps, nullptr);
    g_object_set(tab->fixed_elements[8], "caps", audio_caps, nullptr);
    gst_caps_unref(audio_caps);

    if (!AddTabElements(*tab, error)) return false;
    if (!gst_element_link_many(
            tab->fixed_elements[0], tab->fixed_elements[1], tab->fixed_elements[2],
            tab->fixed_elements[3], tab->fixed_elements[4], tab->mixer, nullptr)
        || !gst_element_link_many(
            tab->mixer, tab->fixed_elements[5], tab->fixed_elements[6],
            tab->fixed_elements[7], tab->fixed_elements[8], nullptr)) {
      *error = "TAB_AUDIO_LINK_FAILED";
      DestroyTabElements(*tab);
      return false;
    }

    GstPad* video = gst_element_get_static_pad(tab->source, "video");
    GstPad* audio = gst_element_get_static_pad(tab->fixed_elements[8], "src");
    tab->video_selector_pad = gst_element_request_pad_simple(video_selector_, "sink_%u");
    tab->audio_selector_pad = gst_element_request_pad_simple(audio_selector_, "sink_%u");
    const bool linked = video && audio && tab->video_selector_pad && tab->audio_selector_pad
        && gst_pad_link(video, tab->video_selector_pad) == GST_PAD_LINK_OK
        && gst_pad_link(audio, tab->audio_selector_pad) == GST_PAD_LINK_OK;
    if (video) gst_object_unref(video);
    if (audio) gst_object_unref(audio);
    if (!linked) {
      *error = "TAB_SELECTOR_LINK_FAILED";
      DestroyTabElements(*tab);
      return false;
    }

    tab->pad_added_handler = g_signal_connect(tab->source, "pad-added", G_CALLBACK(OnPadAdded), this);
    tab->pad_removed_handler = g_signal_connect(tab->source, "pad-removed", G_CALLBACK(OnPadRemoved), this);
    Tab* tab_pointer = tab.get();
    tabs_.emplace(id, std::move(tab));
    if (running_ && !SynchronizeTab(*tab_pointer)) {
      auto failed = std::move(tabs_.at(id));
      tabs_.erase(id);
      DestroyTabElements(*failed);
      *error = "TAB_STATE_CHANGE_FAILED";
      return false;
    }
    if ((activate || active_tab_id_.empty()) && !ActivateTab(id, error)) {
      auto failed = std::move(tabs_.at(id));
      tabs_.erase(id);
      DestroyTabElements(*failed);
      return false;
    }
    return true;
  }

  void ReleaseDetachedTabElements(Tab& tab) {
    if (tab.source) gst_object_unref(tab.source);
    if (tab.mixer) gst_object_unref(tab.mixer);
    for (GstElement* element : tab.fixed_elements) gst_object_unref(element);
    tab.source = nullptr;
    tab.mixer = nullptr;
    tab.fixed_elements.clear();
  }

  bool AddTabElements(Tab& tab, std::string* error) {
    std::vector<GstElement*> elements = {tab.source, tab.mixer};
    elements.insert(elements.end(), tab.fixed_elements.begin(), tab.fixed_elements.end());
    std::size_t added = 0;
    for (; added < elements.size(); ++added) {
      if (!gst_bin_add(GST_BIN(pipeline_), elements[added])) break;
    }
    if (added == elements.size()) return true;
    for (std::size_t index = 0; index < added; ++index) {
      gst_element_set_state(elements[index], GST_STATE_NULL);
      gst_bin_remove(GST_BIN(pipeline_), elements[index]);
    }
    for (std::size_t index = added; index < elements.size(); ++index) {
      gst_object_unref(elements[index]);
    }
    tab.source = nullptr;
    tab.mixer = nullptr;
    tab.fixed_elements.clear();
    *error = "TAB_PIPELINE_ADD_FAILED";
    return false;
  }

  bool SynchronizeTab(Tab& tab) {
    bool synchronized = gst_element_sync_state_with_parent(tab.mixer);
    for (GstElement* element : tab.fixed_elements) {
      synchronized = gst_element_sync_state_with_parent(element) && synchronized;
    }
    return gst_element_sync_state_with_parent(tab.source) && synchronized;
  }

  bool ActivateTab(const std::string& id, std::string* error) {
    auto iterator = tabs_.find(id);
    if (iterator == tabs_.end()) {
      *error = "TAB_NOT_FOUND";
      return false;
    }
    g_object_set(video_selector_, "active-pad", iterator->second->video_selector_pad, nullptr);
    g_object_set(audio_selector_, "active-pad", iterator->second->audio_selector_pad, nullptr);
    active_tab_id_ = id;
    return true;
  }

  bool NavigateTab(const std::string& id, const std::string& url, std::string* error) {
    auto iterator = tabs_.find(id);
    if (iterator == tabs_.end()) {
      *error = "TAB_NOT_FOUND";
      return false;
    }
    if (!ValidUrl(url)) {
      *error = "TAB_INPUT_INVALID";
      return false;
    }
    g_object_set(iterator->second->source, "location", url.c_str(), nullptr);
    iterator->second->url = url;
    return true;
  }

  bool RemoveTab(const std::string& id, const std::string& fallback_id, std::string* error) {
    auto iterator = tabs_.find(id);
    if (iterator == tabs_.end()) {
      *error = "TAB_NOT_FOUND";
      return false;
    }
    if (tabs_.size() == 1) {
      *error = "TAB_MINIMUM_REACHED";
      return false;
    }
    auto fallback = tabs_.find(fallback_id);
    if (fallback == tabs_.end() || fallback == iterator) {
      *error = "TAB_FALLBACK_INVALID";
      return false;
    }
    if (active_tab_id_ == id) {
      if (!ActivateTab(fallback->first, error)) return false;
    } else if (active_tab_id_ != fallback_id) {
      *error = "TAB_FALLBACK_INVALID";
      return false;
    }
    std::unique_ptr<Tab> tab = std::move(iterator->second);
    tabs_.erase(iterator);
    DestroyTabElements(*tab);
    return true;
  }

  void DestroyTabElements(Tab& tab) {
    if (tab.source && tab.pad_added_handler) g_signal_handler_disconnect(tab.source, tab.pad_added_handler);
    if (tab.source && tab.pad_removed_handler) g_signal_handler_disconnect(tab.source, tab.pad_removed_handler);
    while (!tab.audio_branches.empty()) RemoveAudioBranch(tab, tab.audio_branches.back().get());
    if (tab.source) gst_element_set_state(tab.source, GST_STATE_NULL);
    if (tab.mixer) gst_element_set_state(tab.mixer, GST_STATE_NULL);
    for (GstElement* element : tab.fixed_elements) gst_element_set_state(element, GST_STATE_NULL);
    ReleaseSelectorPad(video_selector_, tab.video_selector_pad);
    ReleaseSelectorPad(audio_selector_, tab.audio_selector_pad);
    if (pipeline_ && tab.source) gst_bin_remove(GST_BIN(pipeline_), tab.source);
    if (pipeline_ && tab.mixer) gst_bin_remove(GST_BIN(pipeline_), tab.mixer);
    if (pipeline_) {
      for (GstElement* element : tab.fixed_elements) gst_bin_remove(GST_BIN(pipeline_), element);
    }
    tab.source = nullptr;
    tab.mixer = nullptr;
    tab.fixed_elements.clear();
  }

  void AttachAudioPad(GstElement* source, GstPad* pad) {
    const gchar* name = GST_PAD_NAME(pad);
    if (!name || !g_str_has_prefix(name, "audio_")) return;
    Tab* tab = FindTab(source);
    if (!tab) return;
    if (std::any_of(tab->audio_branches.begin(), tab->audio_branches.end(),
                    [&](const auto& branch) { return branch->source_pad == pad; })) {
      return;
    }
    auto branch = std::make_unique<AudioBranch>();
    branch->source_pad = GST_PAD(gst_object_ref(pad));
    const std::string suffix = std::to_string(next_element_id_++);
    for (const auto& factory : {"queue", "audioconvert", "audioresample", "capsfilter"}) {
      GstElement* element = MakeElement(factory, "tab_audio_" + suffix + "_" + factory, nullptr);
      if (!element) {
        for (GstElement* created : branch->elements) gst_object_unref(created);
        gst_object_unref(branch->source_pad);
        return;
      }
      branch->elements.push_back(element);
    }
    for (GstElement* element : branch->elements) gst_bin_add(GST_BIN(pipeline_), element);
    GstCaps* caps = gst_caps_new_simple(
        "audio/x-raw", "format", G_TYPE_STRING, "S16LE", "rate", G_TYPE_INT,
        48000, "channels", G_TYPE_INT, 2, nullptr);
    g_object_set(branch->elements[3], "caps", caps, nullptr);
    gst_caps_unref(caps);
    branch->mixer_pad = gst_element_request_pad_simple(tab->mixer, "sink_%u");
    GstPad* queue_sink = gst_element_get_static_pad(branch->elements[0], "sink");
    GstPad* caps_source = gst_element_get_static_pad(branch->elements[3], "src");
    const bool linked = branch->mixer_pad && queue_sink && caps_source
        && gst_pad_link(pad, queue_sink) == GST_PAD_LINK_OK
        && gst_element_link_many(branch->elements[0], branch->elements[1],
                                 branch->elements[2], branch->elements[3], nullptr)
        && gst_pad_link(caps_source, branch->mixer_pad) == GST_PAD_LINK_OK;
    if (queue_sink) gst_object_unref(queue_sink);
    if (caps_source) gst_object_unref(caps_source);
    if (!linked) {
      RemoveAudioBranch(*tab, branch.get());
      return;
    }
    if (!std::all_of(branch->elements.begin(), branch->elements.end(), [](GstElement* element) {
          return gst_element_sync_state_with_parent(element);
        })) {
      RemoveAudioBranch(*tab, branch.get());
      return;
    }
    tab->audio_branches.push_back(std::move(branch));
  }

  void DetachAudioPad(GstElement* source, GstPad* pad) {
    Tab* tab = FindTab(source);
    if (!tab) return;
    auto iterator = std::find_if(tab->audio_branches.begin(), tab->audio_branches.end(),
                                 [&](const auto& branch) { return branch->source_pad == pad; });
    if (iterator != tab->audio_branches.end()) RemoveAudioBranch(*tab, iterator->get());
  }

  void RemoveAudioBranch(Tab& tab, AudioBranch* branch) {
    auto iterator = std::find_if(tab.audio_branches.begin(), tab.audio_branches.end(),
                                 [&](const auto& value) { return value.get() == branch; });
    for (GstElement* element : branch->elements) gst_element_set_state(element, GST_STATE_NULL);
    if (branch->source_pad && !branch->elements.empty()) {
      GstPad* sink = gst_element_get_static_pad(branch->elements.front(), "sink");
      if (sink) {
        gst_pad_unlink(branch->source_pad, sink);
        gst_object_unref(sink);
      }
    }
    if (branch->mixer_pad) {
      gst_element_release_request_pad(tab.mixer, branch->mixer_pad);
      gst_object_unref(branch->mixer_pad);
    }
    if (pipeline_) {
      for (GstElement* element : branch->elements) gst_bin_remove(GST_BIN(pipeline_), element);
    }
    if (branch->source_pad) gst_object_unref(branch->source_pad);
    branch->elements.clear();
    branch->source_pad = nullptr;
    branch->mixer_pad = nullptr;
    if (iterator != tab.audio_branches.end()) tab.audio_branches.erase(iterator);
  }

  void ReleaseSelectorPad(GstElement* selector, GstPad*& pad) {
    if (!selector || !pad) return;
    gst_element_release_request_pad(selector, pad);
    gst_object_unref(pad);
    pad = nullptr;
  }

  Tab* FindTab(GstElement* source) {
    for (auto& [id, tab] : tabs_) {
      (void)id;
      if (tab->source == source) return tab.get();
    }
    return nullptr;
  }

  void HandleCommand(std::string line) {
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) line.pop_back();
    std::istringstream stream(line);
    std::vector<std::string> fields;
    for (std::string field; stream >> field;) fields.push_back(field);
    if (fields.size() == 2 && fields[0] == "SHUTDOWN" && ValidRequest(fields[1])) {
      ReplyOk(fields[1]);
      g_main_loop_quit(loop_);
      return;
    }
    if (fields.size() < 3 || !ValidRequest(fields[1])) {
      exit_code_ = 1;
      g_main_loop_quit(loop_);
      return;
    }
    const std::string& command = fields[0];
    const std::string& request = fields[1];
    const std::string& id = fields[2];
    std::string error;
    bool success = false;
    if (command == "ACTIVATE" && fields.size() == 3) {
      success = ActivateTab(id, &error);
    } else if (command == "DELETE" && fields.size() == 4) {
      success = RemoveTab(id, fields[3], &error);
    } else if ((command == "CREATE" || command == "NAVIGATE") && fields.size() == 4) {
      auto url = DecodeHex(fields[3]);
      if (url && ValidUrl(*url)) {
        success = command == "CREATE" ? CreateTab(id, *url, true, &error)
                                        : NavigateTab(id, *url, &error);
      } else {
        error = "TAB_INPUT_INVALID";
      }
    } else {
      error = "TAB_COMMAND_INVALID";
    }
    if (success) ReplyOk(request);
    else ReplyError(request, error.empty() ? "TAB_RUNTIME_FAILURE" : error);
  }

  void ReplyOk(const std::string& request) { std::cout << "OK " << request << std::endl; }

  void ReplyError(const std::string& request, const std::string& code) {
    std::cout << "ERR " << request << " " << SafeErrorCode(code) << std::endl;
  }

  static std::string SafeErrorCode(const std::string& value) {
    if (!value.empty() && value.size() <= 64
        && std::all_of(value.begin(), value.end(), [](unsigned char character) {
             return character == '_' || (character >= 'A' && character <= 'Z');
           })) {
      return value;
    }
    return "TAB_RUNTIME_FAILURE";
  }

  static bool ValidRequest(const std::string& value) {
    return !value.empty() && value.size() <= 16
        && value[0] >= '1' && value[0] <= '9'
        && std::all_of(value.begin(), value.end(), [](unsigned char character) {
             return std::isdigit(character) != 0;
           });
  }

 public:
  static bool ValidUuid(const std::string& value) {
    if (value.size() != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-') {
      return false;
    }
    for (std::size_t index = 0; index < value.size(); ++index) {
      if (index == 8 || index == 13 || index == 18 || index == 23) continue;
      if (!std::isxdigit(static_cast<unsigned char>(value[index])) || std::isupper(value[index])) return false;
    }
    return value[14] == '4' && (value[19] == '8' || value[19] == '9' || value[19] == 'a' || value[19] == 'b');
  }

  static bool ValidUrl(const std::string& value) {
    if (value.empty() || value.size() > kMaximumUrlBytes) return false;
    if (value == kInternalHome) return true;
    GError* error = nullptr;
    GUri* uri = g_uri_parse(value.c_str(), G_URI_FLAGS_NONE, &error);
    if (!uri) {
      if (error) g_error_free(error);
      return false;
    }
    const char* scheme = g_uri_get_scheme(uri);
    const char* host = g_uri_get_host(uri);
    const char* userinfo = g_uri_get_userinfo(uri);
    const bool valid = scheme && host && *host && !userinfo
        && (g_str_equal(scheme, "http") || g_str_equal(scheme, "https"));
    g_uri_unref(uri);
    return valid;
  }

  static std::optional<std::string> DecodeHex(const std::string& value) {
    if (value.empty() || value.size() > kMaximumUrlBytes * 2 || value.size() % 2 != 0) return std::nullopt;
    std::string result;
    result.reserve(value.size() / 2);
    for (std::size_t index = 0; index < value.size(); index += 2) {
      int high = HexValue(value[index]);
      int low = HexValue(value[index + 1]);
      if (high < 0 || low < 0) return std::nullopt;
      const char decoded = static_cast<char>((high << 4) | low);
      if (decoded == '\0') return std::nullopt;
      result.push_back(decoded);
    }
    return result;
  }

  static int HexValue(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
  }

 private:
  Configuration configuration_;
  GstElement* pipeline_ = nullptr;
  GstElement* video_selector_ = nullptr;
  GstElement* audio_selector_ = nullptr;
  GMainLoop* loop_ = nullptr;
  std::unordered_map<std::string, std::unique_ptr<Tab>> tabs_;
  std::string active_tab_id_;
  std::uint64_t next_element_id_ = 1;
  guint bus_watch_id_ = 0;
  guint input_watch_id_ = 0;
  bool running_ = false;
  int exit_code_ = 0;
};

bool ParsePositiveInteger(const std::string& value, int maximum, int* result) {
  if (value.empty() || value.size() > 10
      || !std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return std::isdigit(character) != 0;
         })) {
    return false;
  }
  try {
    const long parsed = std::stol(value);
    if (parsed < 1 || parsed > maximum) return false;
    *result = static_cast<int>(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

std::optional<Configuration> ParseArguments(int argc, char** argv) {
  if (argc != 19) return std::nullopt;
  std::unordered_map<std::string, std::string> values;
  for (int index = 1; index < argc; index += 2) {
    if (index + 1 >= argc || argv[index][0] != '-' || values.contains(argv[index])) return std::nullopt;
    values.emplace(argv[index], argv[index + 1]);
  }
  const std::vector<std::string> required = {
      "--width", "--height", "--fps", "--bitrate", "--initial-tab-id",
      "--initial-url-hex", "--stun-server", "--turn-servers", "--ice-policy"};
  if (values.size() != required.size()
      || !std::all_of(required.begin(), required.end(), [&](const auto& key) { return values.contains(key); })) {
    return std::nullopt;
  }
  Configuration configuration;
  if (!ParsePositiveInteger(values["--width"], 4096, &configuration.width)
      || !ParsePositiveInteger(values["--height"], 2160, &configuration.height)
      || !ParsePositiveInteger(values["--fps"], 60, &configuration.fps)
      || !ParsePositiveInteger(values["--bitrate"], 50000000, &configuration.bitrate)) {
    return std::nullopt;
  }
  configuration.initial_tab_id = values["--initial-tab-id"];
  auto initial_url = Runtime::DecodeHex(values["--initial-url-hex"]);
  if (!initial_url || !Runtime::ValidUuid(configuration.initial_tab_id) || !Runtime::ValidUrl(*initial_url)) {
    return std::nullopt;
  }
  configuration.initial_url = std::move(*initial_url);
  configuration.stun_server = values["--stun-server"];
  configuration.turn_servers = values["--turn-servers"];
  configuration.ice_policy = values["--ice-policy"];
  if (!(configuration.ice_policy == "all" || configuration.ice_policy == "relay")) return std::nullopt;
  return configuration;
}

}  // namespace

int main(int argc, char** argv) {
  gst_init(nullptr, nullptr);
  auto configuration = ParseArguments(argc, argv);
  if (!configuration) {
    std::cerr << "fireball-session-runtime: invalid arguments" << std::endl;
    return 64;
  }
  Runtime runtime(std::move(*configuration));
  std::string error;
  if (!runtime.Initialize(&error)) {
    std::cerr << "fireball-session-runtime: startup failed: " << error << std::endl;
    return 1;
  }
  return runtime.Run();
}
