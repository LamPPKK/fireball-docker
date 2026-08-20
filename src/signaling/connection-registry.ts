export type SignalingConnectionCloser = () => void;

export class SignalingConnectionRegistry {
  private readonly connections = new Map<string, Set<SignalingConnectionCloser>>();

  public register(sessionId: string, close: SignalingConnectionCloser): () => void {
    const connections = this.connections.get(sessionId) ?? new Set<SignalingConnectionCloser>();
    connections.add(close);
    this.connections.set(sessionId, connections);
    return () => {
      connections.delete(close);
      if (connections.size === 0) this.connections.delete(sessionId);
    };
  }

  public revoke(sessionId: string): void {
    const connections = this.connections.get(sessionId);
    if (!connections) return;
    this.connections.delete(sessionId);
    for (const close of connections) {
      try {
        close();
      } catch {
        // Revocation must continue for every connection even if one closer is faulty.
      }
    }
  }

  public count(sessionId: string): number {
    return this.connections.get(sessionId)?.size ?? 0;
  }
}
