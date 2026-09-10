import {
  addCapability,
  addEvent,
  createInitialState,
  createReview,
  deleteCapability,
  getPrompts,
  updateCapability,
  updateEvent,
} from './domain.js';
import { captureDraftFromForm, changeCaptureType } from './capture.js';
import { createStorage } from './storage.js';
import { syncConfig } from './sync-config.js';
import { createSupabaseSync, isSyncConfigured, mergeStates } from './sync.js';

const storage = createStorage(window.localStorage);
let state = storage.load();
let activeView = 'inbox';
let notice = '';
let captureDraft = { content: '', type: '' };
let eventEditorId = '';
let eventEditDraft = { content: '', type: '' };
let capabilityEditorId = '';
let reviewDraft = newReviewDraft();
let syncClient = null;
let cloudSession = null;
let syncPanelOpen = false;
let syncSaveTimer = null;
let syncStatus = {
  kind: isSyncConfigured(syncConfig) ? 'connecting' : 'local',
  detail: isSyncConfigured(syncConfig) ? '正在连接同步服务…' : '目前仅保存在这台设备',
  lastSyncedAt: '',
};

function newReviewDraft() {
  return {
    eventIds: [],
    subject: '',
    mode: 'standard',
    capabilityId: '',
    answers: [],
    triggerSituation: '',
    responseAction: '',
  };
}

function localDate(value = new Date()) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function chineseDate(value = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(value));
}

function todaysEvents() {
  const today = localDate();
  return state.events.filter(event => localDate(event.createdAt) === today);
}

function persist(nextState) {
  state = nextState;
  storage.save(state);
  scheduleCloudSave();
}

function setNotice(message, isError = false) {
  notice = message ? { message, isError } : '';
}

function syncStatusLabel() {
  if (syncStatus.kind === 'synced') return '已同步';
  if (syncStatus.kind === 'syncing') return '同步中';
  if (syncStatus.kind === 'error') return '同步待重试';
  if (syncStatus.kind === 'signed-out') return '登录并同步';
  if (syncStatus.kind === 'connecting') return '连接同步中';
  return '本地保存';
}

function renderSyncPanel() {
  if (!syncPanelOpen) return '';
  if (!isSyncConfigured(syncConfig)) {
    return `<section class="sync-panel"><strong>目前仅本机保存</strong><p>同步功能已准备好；连接你自己的云端项目后，手机和电脑就会使用同一份数据。</p></section>`;
  }
  if (!cloudSession) {
    return `<section class="sync-panel stack"><strong>登录并同步</strong><p>输入邮箱后，打开邮件里的登录链接。第一次登录会安全地把这台设备的内容带入你的账号。</p><form id="sync-login-form" class="row"><input name="email" type="email" autocomplete="email" placeholder="你的邮箱" required><button class="button compact" type="submit">发送登录链接</button></form><span class="meta">${escapeHtml(syncStatus.detail)}</span></section>`;
  }
  const syncedText = syncStatus.lastSyncedAt ? `上次同步：${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(syncStatus.lastSyncedAt))}` : syncStatus.detail;
  return `<section class="sync-panel stack"><div class="row between"><div><strong>已登录</strong><p class="meta">${escapeHtml(cloudSession.user.email ?? '')}<br>${escapeHtml(syncedText)}</p></div><span class="sync-dot ${syncStatus.kind}">${escapeHtml(syncStatusLabel())}</span></div><div class="row"><button type="button" class="button secondary compact" data-retry-sync>立即同步</button><button type="button" class="text-button" data-sign-out>退出登录</button></div></section>`;
}

function renderShell(content) {
  const nav = [
    ['inbox', '记录'],
    ['review', '复盘'],
    ['rules', '规则'],
  ].map(([view, label]) => `<button type="button" data-view="${view}" class="${activeView === view ? 'active' : ''}">${label}</button>`).join('');
  return `
    <div class="shell">
      <header>
        <div class="topline"><h1 class="brand">回声</h1><span class="date">${chineseDate()}</span></div>
        <p class="intro">先收下想法、灵感和重要信息；需要时，再认真复盘一件事。</p>
        <button type="button" class="sync-control" data-toggle-sync>${escapeHtml(syncStatusLabel())}</button>
        ${renderSyncPanel()}
      </header>
      ${notice ? `<p class="notice ${notice.isError ? 'error' : ''}">${escapeHtml(notice.message)}</p>` : ''}
      ${content}
    </div>
    <nav class="nav" aria-label="主导航">${nav}</nav>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function typeLabel(type) {
  return { work: '工作', life: '生活', social: '社交', idea: '灵感' }[type] ?? '';
}

function eventCard(event, selectable = false, selected = false) {
  if (!selectable && eventEditorId === event.id) {
    const typeOptions = [['', '不分类'], ['work', '工作'], ['life', '生活'], ['social', '社交'], ['idea', '灵感']]
      .map(([type, label]) => `<button type="button" class="choice ${eventEditDraft.type === type ? 'selected' : ''}" data-event-edit-type="${type}">${label}</button>`).join('');
    return `<article class="event event-editing">
      <form id="event-edit-form" class="stack">
        <label>继续补充这条内容<textarea name="content" autofocus>${escapeHtml(eventEditDraft.content)}</textarea></label>
        <div class="type-choice" aria-label="修改分类">${typeOptions}</div>
        <div class="row"><button class="button compact" type="submit">保存修改</button><button class="text-button" type="button" data-cancel-event-edit>取消</button></div>
      </form>
    </article>`;
  }
  return `<article class="event">
    ${selectable ? `<input aria-label="选择：${escapeHtml(event.content)}" type="checkbox" name="eventIds" value="${event.id}" ${selected ? 'checked' : ''}>` : ''}
    <div class="event-content"><p>${escapeHtml(event.content)}</p><div class="top-gap meta">${event.type ? `<span class="tag">${typeLabel(event.type)}</span>` : '未分类'} · ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(event.createdAt))}${!selectable ? `<button class="text-button edit-record" type="button" data-edit-event="${event.id}">编辑</button>` : ''}</div></div>
  </article>`;
}

function renderInbox() {
  const typeOptions = [['', '不分类'], ['work', '工作'], ['life', '生活'], ['social', '社交'], ['idea', '灵感']]
    .map(([type, label]) => `<button type="button" class="choice ${captureDraft.type === type ? 'selected' : ''}" data-capture-type="${type}">${label}</button>`).join('');
  const events = todaysEvents();
  return renderShell(`
    <section class="capture">
      <form id="capture-form" class="stack">
        <label>现在想留下一点什么？<textarea name="content" autofocus placeholder="灵感、想法、提醒、观察……先写下来。">${escapeHtml(captureDraft.content)}</textarea></label>
        <div class="type-choice" aria-label="可选分类">${typeOptions}</div>
        <button class="button" type="submit">保存这条记录</button>
      </form>
    </section>
    <div class="section-heading"><strong>今天收下的内容</strong><span class="meta">${events.length} 条</span></div>
    <section class="event-list">${events.length ? events.map(event => eventCard(event)).join('') : '<div class="empty">还没有记录。<br>灵感、想法和重要信息，都可以先放在这里。</div>'}</section>
  `);
}

function getReviewCapability() {
  return state.capabilities.find(capability => capability.id === reviewDraft.capabilityId);
}

function reviewPrompts() {
  return getPrompts(reviewDraft.mode, getReviewCapability());
}

function renderCapabilityEditor() {
  const editing = state.capabilities.find(capability => capability.id === capabilityEditorId);
  const title = editing ? `编辑「${escapeHtml(editing.name)}」` : '新建能力模板';
  return `<form id="capability-form" class="stack top-gap">
    <input type="hidden" name="id" value="${editing?.id ?? ''}">
    <label>${title}<input name="name" value="${escapeHtml(editing?.name ?? '')}" placeholder="例如：大局观" required></label>
    <label>做到位的标准 <span class="field-note">可选，作为你长期的参照物</span><textarea name="successDefinition" placeholder="例如：能判断自己的角色是否结束，并完成交接。">${escapeHtml(editing?.successDefinition ?? '')}</textarea></label>
    <label>复盘问题 <span class="field-note">每行一个；顺序就是提问顺序</span><textarea name="questions" placeholder="真正最重要的结果是什么？\n我忽略了什么？">${escapeHtml(editing?.questions?.join('\n') ?? '')}</textarea></label>
    <div class="row"><button class="button compact" type="submit">${editing ? '保存修改' : '添加能力'}</button>${editing ? '<button type="button" class="text-button" data-cancel-capability>取消</button>' : ''}</div>
  </form>`;
}

function renderCapabilityManager() {
  const cards = state.capabilities.length
    ? state.capabilities.map(capability => `<article class="capability-card"><div class="row between"><strong>${escapeHtml(capability.name)}</strong><span><button type="button" class="text-button" data-edit-capability="${capability.id}">编辑</button><button type="button" class="text-button danger" data-delete-capability="${capability.id}">删除</button></span></div>${capability.successDefinition ? `<p class="meta">做到位：${escapeHtml(capability.successDefinition)}</p>` : ''}${capability.questions.length ? `<ol>${capability.questions.map(question => `<li>${escapeHtml(question)}</li>`).join('')}</ol>` : '<p class="meta">还没有额外问题。</p>'}</article>`).join('')
    : '<p class="meta">还没有能力模板。需要时再添加，不必一次设完。</p>';
  return `<details class="panel" ${capabilityEditorId ? 'open' : ''}><summary>管理能力与个人问题</summary><div class="stack">${cards}${renderCapabilityEditor()}</div></details>`;
}

function renderReview() {
  const events = todaysEvents();
  const prompts = reviewPrompts();
  const options = [['quick', '极速', '1 分钟'], ['standard', '标准', '3–5 分钟'], ['deep', '深度', '10 分钟']]
    .map(([mode, label, description]) => `<button type="button" class="mode ${reviewDraft.mode === mode ? 'active' : ''}" data-mode="${mode}"><strong>${label}</strong><small>${description}</small></button>`).join('');
  const capabilityOptions = ['<option value="">不使用额外能力问题</option>', ...state.capabilities.map(capability => `<option value="${capability.id}" ${reviewDraft.capabilityId === capability.id ? 'selected' : ''}>${escapeHtml(capability.name)}</option>`)].join('');
  const questionFields = prompts.map((prompt, index) => `<label class="question">${index + 1}. ${escapeHtml(prompt)}<textarea name="answer-${index}" data-answer-index="${index}" placeholder="写下真实的想法…">${escapeHtml(reviewDraft.answers[index] ?? '')}</textarea></label>`).join('');
  return renderShell(`
    <section class="panel stack-lg">
      <div><h2>今日复盘</h2><p class="intro">复盘是独立的思考。先写下你想看清的那件事；记录只在需要时作为参考。</p></div>
      <form id="review-form" class="stack-lg">
        <label>1. 今天想复盘什么？<textarea name="reviewSubject" placeholder="例如：我在会议上太快否定了同事的建议。">${escapeHtml(reviewDraft.subject)}</textarea></label>
        <details class="panel"><summary>从今天的记录中带入（可选）</summary>${events.length ? `<div class="event-list">${events.map(event => eventCard(event, true, reviewDraft.eventIds.includes(event.id))).join('')}</div>` : '<p class="meta">今天还没有收集内容；这不影响你直接开始复盘。</p>'}</details>
        <div class="stack"><strong>2. 今天想复盘到什么深度？</strong><div class="mode-grid">${options}</div></div>
        <label>3. 要用哪项能力来观察？<span class="field-note">可选；会追加你自己写的问题</span><select id="capability-select" name="capabilityId">${capabilityOptions}</select></label>
        <div class="stack"><strong>4. 回答这些问题</strong>${questionFields}</div>
        <div class="rule-preview">最后把经验写成一个能执行的触发规则：<br>当＿＿发生时，我将＿＿。</div>
        <label>触发场景<input name="triggerSituation" value="${escapeHtml(reviewDraft.triggerSituation)}" placeholder="例如：准备退出重要事务" required></label>
        <label>下次的具体行动<input name="responseAction" value="${escapeHtml(reviewDraft.responseAction)}" placeholder="例如：先完成交接并确认角色结束" required></label>
        <button class="button" type="submit">保存复盘与触发规则</button>
      </form>
    </section>
    <div class="top-gap">${renderCapabilityManager()}</div>
  `);
}

function sourceSummary(rule) {
  const review = state.reviews.find(item => item.id === rule.reviewId);
  if (review?.subject) return review.subject;
  const events = review?.eventIds.map(id => state.events.find(event => event.id === id)?.content).filter(Boolean) ?? [];
  return events.join('、') || '已删除的记录';
}

function renderRules() {
  const rules = state.rules;
  return renderShell(`
    <section class="panel"><h2>触发规则</h2><p class="intro">不是“以后要更好”，而是为特定场景提前准备一个动作。</p>${rules.length ? `<div class="rule-list">${rules.map(rule => `<article class="rule"><q>${escapeHtml(rule.statement)}</q><p class="meta top-gap">来自：${escapeHtml(sourceSummary(rule))}<br>${chineseDate(rule.createdAt)}</p></article>`).join('')}</div>` : '<div class="empty">还没有规则。<br>完成一次复盘后，你的经验会出现在这里。</div>'}</section>
  `);
}

function render() {
  const content = activeView === 'review' ? renderReview() : activeView === 'rules' ? renderRules() : renderInbox();
  document.querySelector('#app').innerHTML = content;
  bindEvents();
}

function syncReviewDraftFromForm(form) {
  reviewDraft.eventIds = [...form.querySelectorAll('input[name="eventIds"]:checked')].map(input => input.value);
  reviewDraft.subject = form.elements.namedItem('reviewSubject')?.value ?? '';
  reviewDraft.answers = reviewPrompts().map((_, index) => form.elements[`answer-${index}`]?.value ?? '');
  reviewDraft.triggerSituation = form.elements.namedItem('triggerSituation')?.value ?? '';
  reviewDraft.responseAction = form.elements.namedItem('responseAction')?.value ?? '';
}

function setSyncStatus(kind, detail, lastSyncedAt = syncStatus.lastSyncedAt) {
  syncStatus = { kind, detail, lastSyncedAt };
}

async function synchronizeFromCloud() {
  if (!syncClient || !cloudSession) return;
  setSyncStatus('syncing', '正在合并这台设备与云端的内容…');
  render();
  try {
    const remote = await syncClient.loadState(cloudSession.user.id);
    const merged = remote?.state ? mergeStates(state, remote.state) : state;
    state = merged;
    storage.save(state);
    await syncClient.saveState(cloudSession.user.id, state);
    setSyncStatus('synced', '同步完成', new Date().toISOString());
  } catch (error) {
    setSyncStatus('error', `本机内容已保留；同步失败：${error.message}`);
  }
  render();
}

function scheduleCloudSave() {
  if (!syncClient || !cloudSession) return;
  window.clearTimeout(syncSaveTimer);
  syncSaveTimer = window.setTimeout(async () => {
    try {
      setSyncStatus('syncing', '正在保存到云端…');
      render();
      await syncClient.saveState(cloudSession.user.id, state);
      setSyncStatus('synced', '同步完成', new Date().toISOString());
    } catch (error) {
      setSyncStatus('error', `本机内容已保留；同步失败：${error.message}`);
    }
    render();
  }, 500);
}

async function handleCloudSession(nextSession) {
  const priorUserId = cloudSession?.user?.id;
  cloudSession = nextSession;
  if (!cloudSession) {
    setSyncStatus('signed-out', '登录后可在手机和电脑之间同步');
    render();
    return;
  }
  if (priorUserId !== cloudSession.user.id) await synchronizeFromCloud();
  else {
    setSyncStatus('synced', '已登录', new Date().toISOString());
    render();
  }
}

async function initializeSync() {
  if (!isSyncConfigured(syncConfig)) return;
  try {
    syncClient = await createSupabaseSync(syncConfig);
    syncClient.onAuthStateChange(handleCloudSession);
    await handleCloudSession(await syncClient.getSession());
  } catch (error) {
    setSyncStatus('error', `同步服务暂时不可用：${error.message}`);
    render();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    activeView = button.dataset.view;
    setNotice('');
    render();
  }));

  document.querySelector('[data-toggle-sync]')?.addEventListener('click', () => {
    syncPanelOpen = !syncPanelOpen;
    render();
  });

  document.querySelector('#sync-login-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await syncClient.requestMagicLink(new FormData(event.currentTarget).get('email'));
      setSyncStatus('signed-out', '登录链接已发送，请在邮箱中打开它。');
      render();
    } catch (error) {
      setSyncStatus('error', `无法发送登录链接：${error.message}`);
      render();
    }
  });

  document.querySelector('[data-retry-sync]')?.addEventListener('click', () => synchronizeFromCloud());
  document.querySelector('[data-sign-out]')?.addEventListener('click', async () => {
    try {
      await syncClient.signOut();
    } catch (error) {
      setSyncStatus('error', `无法退出登录：${error.message}`);
      render();
    }
  });

  document.querySelectorAll('[data-capture-type]').forEach(button => button.addEventListener('click', () => {
    const form = document.querySelector('#capture-form');
    captureDraft = changeCaptureType(captureDraftFromForm(form, captureDraft), button.dataset.captureType);
    render();
  }));

  document.querySelectorAll('[data-edit-event]').forEach(button => button.addEventListener('click', () => {
    const eventToEdit = state.events.find(item => item.id === button.dataset.editEvent);
    if (!eventToEdit) return;
    eventEditorId = eventToEdit.id;
    eventEditDraft = { content: eventToEdit.content, type: eventToEdit.type };
    setNotice('');
    render();
  }));

  document.querySelectorAll('[data-event-edit-type]').forEach(button => button.addEventListener('click', () => {
    const form = document.querySelector('#event-edit-form');
    eventEditDraft = changeCaptureType(captureDraftFromForm(form, eventEditDraft), button.dataset.eventEditType);
    render();
  }));

  document.querySelector('#event-edit-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      persist(updateEvent(state, eventEditorId, { content: new FormData(form).get('content'), type: eventEditDraft.type }));
      eventEditorId = '';
      eventEditDraft = { content: '', type: '' };
      setNotice('记录已更新。');
      render();
    } catch (error) {
      setNotice(error.message, true);
      render();
    }
  });

  document.querySelector('[data-cancel-event-edit]')?.addEventListener('click', () => {
    eventEditorId = '';
    eventEditDraft = { content: '', type: '' };
    setNotice('');
    render();
  });

  const captureForm = document.querySelector('#capture-form');
  captureForm?.addEventListener('submit', event => {
    event.preventDefault();
    try {
      persist(addEvent(state, { content: new FormData(captureForm).get('content'), type: captureDraft.type }));
      captureDraft = { content: '', type: '' };
      setNotice('已收下。现在不用整理它。');
      render();
    } catch (error) {
      setNotice(error.message, true);
      render();
    }
  });

  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    const form = document.querySelector('#review-form');
    if (form) syncReviewDraftFromForm(form);
    reviewDraft.mode = button.dataset.mode;
    reviewDraft.answers = [];
    render();
  }));

  document.querySelector('#capability-select')?.addEventListener('change', event => {
    const form = document.querySelector('#review-form');
    if (form) syncReviewDraftFromForm(form);
    reviewDraft.capabilityId = event.target.value;
    reviewDraft.answers = [];
    render();
  });

  const reviewForm = document.querySelector('#review-form');
  reviewForm?.addEventListener('submit', event => {
    event.preventDefault();
    syncReviewDraftFromForm(reviewForm);
    try {
      persist(createReview(state, reviewDraft));
      reviewDraft = newReviewDraft();
      activeView = 'rules';
      setNotice('复盘已保存。你的新规则已经沉淀下来。');
      render();
    } catch (error) {
      setNotice(error.message, true);
      render();
    }
  });

  document.querySelector('#capability-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const input = {
      name: values.get('name'),
      successDefinition: values.get('successDefinition'),
      questions: String(values.get('questions') ?? '').split('\n'),
    };
    try {
      const id = values.get('id');
      persist(id ? updateCapability(state, id, input) : addCapability(state, input));
      capabilityEditorId = '';
      setNotice(id ? '能力模板已更新。' : '能力模板已添加。');
      render();
    } catch (error) {
      setNotice(error.message, true);
      render();
    }
  });

  document.querySelectorAll('[data-edit-capability]').forEach(button => button.addEventListener('click', () => {
    capabilityEditorId = button.dataset.editCapability;
    render();
  }));
  document.querySelector('[data-cancel-capability]')?.addEventListener('click', () => {
    capabilityEditorId = '';
    render();
  });
  document.querySelectorAll('[data-delete-capability]').forEach(button => button.addEventListener('click', () => {
    if (!window.confirm('删除这项能力模板？以前完成的复盘不会被删除。')) return;
    persist(deleteCapability(state, button.dataset.deleteCapability));
    if (reviewDraft.capabilityId === button.dataset.deleteCapability) reviewDraft.capabilityId = '';
    capabilityEditorId = '';
    setNotice('能力模板已删除。');
    render();
  }));
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js'));
}

render();
initializeSync();
window.addEventListener('focus', () => synchronizeFromCloud());
window.addEventListener('online', () => synchronizeFromCloud());
