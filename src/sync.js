const COLLECTIONS = ['events', 'capabilities', 'reviews', 'rules'];

function arrayOf(state, key) {
  return Array.isArray(state?.[key]) ? state[key] : [];
}

function changedAt(item) {
  const timestamp = Date.parse(item?.updatedAt ?? item?.createdAt ?? '');
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function mergeCollection(localItems, remoteItems) {
  const byId = new Map();
  for (const item of remoteItems) byId.set(item.id, item);
  for (const item of localItems) {
    const existing = byId.get(item.id);
    if (!existing || changedAt(item) >= changedAt(existing)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => changedAt(right) - changedAt(left));
}

export function isSyncConfigured(config) {
  return Boolean(String(config?.url ?? '').trim() && String(config?.publishableKey ?? '').trim());
}

export function mergeStates(localState, remoteState) {
  return COLLECTIONS.reduce((merged, collection) => {
    merged[collection] = mergeCollection(arrayOf(localState, collection), arrayOf(remoteState, collection));
    return merged;
  }, {});
}

export async function createSupabaseSync(config) {
  if (!isSyncConfigured(config)) return null;

  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.57.4?target=es2022');
  const client = createClient(config.url.trim(), config.publishableKey.trim(), {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  return {
    async getSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      return data.session;
    },
    onAuthStateChange(listener) {
      const { data } = client.auth.onAuthStateChange((_event, session) => listener(session));
      return () => data.subscription.unsubscribe();
    },
    async requestMagicLink(email) {
      const normalizedEmail = String(email ?? '').trim();
      if (!normalizedEmail) throw new Error('请输入邮箱地址');
      const { error } = await client.auth.signInWithOtp({
        email: normalizedEmail,
        options: { emailRedirectTo: window.location.href.split('#')[0] },
      });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },
    async loadState(userId) {
      const { data, error } = await client
        .from('echo_app_states')
        .select('state, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data ? { state: data.state, updatedAt: data.updated_at } : null;
    },
    async saveState(userId, state) {
      const { error } = await client
        .from('echo_app_states')
        .upsert({ user_id: userId, state, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
    },
  };
}
