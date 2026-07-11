/**
 * LocalStorage-backed profile store + dirty tracking.
 */
import type { GridState } from '@tabular/core';

export interface ProfileSnapshot {
  id: string;
  name: string;
  updatedAt: string;
  gridState: GridState;
  extState?: Record<string, unknown>;
}

export interface ProfileStore {
  list(): Promise<ProfileSnapshot[]>;
  get(id: string): Promise<ProfileSnapshot | null>;
  save(profile: ProfileSnapshot): Promise<void>;
  remove(id: string): Promise<void>;
}

export class LocalStorageProfileStore implements ProfileStore {
  constructor(private readonly keyPrefix: string) {}

  private key(id: string): string {
    return `${this.keyPrefix}:profile:${id}`;
  }

  private indexKey(): string {
    return `${this.keyPrefix}:profiles`;
  }

  async list(): Promise<ProfileSnapshot[]> {
    try {
      const raw = localStorage.getItem(this.indexKey());
      const ids: string[] = raw ? JSON.parse(raw) : [];
      const out: ProfileSnapshot[] = [];
      for (const id of ids) {
        const p = await this.get(id);
        if (p) out.push(p);
      }
      return out;
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<ProfileSnapshot | null> {
    try {
      const raw = localStorage.getItem(this.key(id));
      return raw ? (JSON.parse(raw) as ProfileSnapshot) : null;
    } catch {
      return null;
    }
  }

  async save(profile: ProfileSnapshot): Promise<void> {
    localStorage.setItem(this.key(profile.id), JSON.stringify(profile));
    const raw = localStorage.getItem(this.indexKey());
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(profile.id)) {
      ids.push(profile.id);
      localStorage.setItem(this.indexKey(), JSON.stringify(ids));
    }
  }

  async remove(id: string): Promise<void> {
    localStorage.removeItem(this.key(id));
    const raw = localStorage.getItem(this.indexKey());
    const ids: string[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(this.indexKey(), JSON.stringify(ids.filter((x) => x !== id)));
  }
}

export class ProfilesController {
  dirty = false;

  constructor(
    private store: ProfileStore,
    private getSnapshot: () => Omit<ProfileSnapshot, 'id' | 'name' | 'updatedAt'>,
  ) {}

  markDirty(dirty = true): void {
    this.dirty = dirty;
  }

  async save(name: string, id?: string): Promise<ProfileSnapshot> {
    const base = this.getSnapshot();
    const profile: ProfileSnapshot = {
      id: id ?? `profile-${Date.now().toString(36)}`,
      name,
      updatedAt: new Date().toISOString(),
      ...base,
    };
    await this.store.save(profile);
    this.dirty = false;
    return profile;
  }

  async list(): Promise<ProfileSnapshot[]> {
    return this.store.list();
  }

  async load(id: string): Promise<ProfileSnapshot | null> {
    return this.store.get(id);
  }
}
