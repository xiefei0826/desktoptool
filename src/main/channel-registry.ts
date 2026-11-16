export interface ManagedChannel {
  id: string
  kind: 'ssh' | 'pty' | 'vnc' | 'k8s'
  sessionId: string
  close: () => void
}

/** 统一管理所有活跃数据通道，便于按会话/按应用退出统一清理 */
export class ChannelRegistry {
  private readonly channels = new Map<string, ManagedChannel>()

  add(channel: ManagedChannel): void {
    this.channels.set(channel.id, channel)
  }

  get(id: string): ManagedChannel | undefined {
    return this.channels.get(id)
  }

  remove(id: string): void {
    this.channels.delete(id)
  }

  close(id: string): void {
    const channel = this.channels.get(id)
    if (!channel) return
    this.channels.delete(id)
    try {
      channel.close()
    } catch {
      /* ignore */
    }
  }

  closeBySession(sessionId: string): void {
    for (const channel of [...this.channels.values()]) {
      if (channel.sessionId === sessionId) this.close(channel.id)
    }
  }

  closeAll(): void {
    for (const channel of [...this.channels.values()]) this.close(channel.id)
  }

  countBySession(sessionId: string): number {
    let count = 0
    for (const channel of this.channels.values()) {
      if (channel.sessionId === sessionId) count += 1
    }
    return count
  }
}
