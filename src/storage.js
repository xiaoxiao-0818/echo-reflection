import { createInitialState } from './domain.js';

export function createStorage(adapter, key = 'personal-reflection-state') {
  return {
    load() {
      try {
        const stored = adapter.getItem(key);
        if (!stored) return createInitialState();
        const parsed = JSON.parse(stored);
        return {
          ...createInitialState(),
          ...parsed,
          events: Array.isArray(parsed.events) ? parsed.events : [],
          capabilities: Array.isArray(parsed.capabilities) ? parsed.capabilities : [],
          reviews: Array.isArray(parsed.reviews) ? parsed.reviews : [],
          rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        };
      } catch {
        return createInitialState();
      }
    },
    save(state) {
      adapter.setItem(key, JSON.stringify(state));
    },
  };
}
