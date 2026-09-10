const CORE_PROMPTS = {
  quick: ['今天最大的问题是什么？', '下次遇到类似情况，我具体怎么做？'],
  standard: ['发生了什么？', '我当时为什么这么做？', '哪里判断得不够好？', '下次遇到类似情况，我具体怎么做？'],
  deep: ['发生了什么？', '我当时为什么这么做？', '这件事最重要的结果是什么？', '我忽略了什么？', '哪里判断得不够好？', '下次遇到类似情况，我具体怎么做？'],
};

function createId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function requiredText(value, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(message);
  return text;
}

function copyState(state) {
  return {
    events: [...(state.events ?? [])],
    capabilities: [...(state.capabilities ?? [])],
    reviews: [...(state.reviews ?? [])],
    rules: [...(state.rules ?? [])],
  };
}

export function createInitialState() {
  return { events: [], capabilities: [], reviews: [], rules: [] };
}

export function getPrompts(mode, capability) {
  const core = CORE_PROMPTS[mode] ?? CORE_PROMPTS.standard;
  const personal = capability?.questions?.map(question => String(question).trim()).filter(Boolean) ?? [];
  return [...core, ...personal];
}

export function addEvent(state, input) {
  const content = requiredText(input?.content, '记录内容不能为空');
  const next = copyState(state);
  next.events.unshift({
    id: createId('event'),
    content,
    type: String(input?.type ?? '').trim(),
    createdAt: new Date().toISOString(),
  });
  return next;
}

export function updateEvent(state, eventId, input) {
  const next = copyState(state);
  const index = next.events.findIndex(event => event.id === eventId);
  if (index === -1) throw new Error('没有找到这条记录');

  const current = next.events[index];
  next.events[index] = {
    ...current,
    content: requiredText(input?.content, '记录内容不能为空'),
    type: String(input?.type ?? '').trim(),
    updatedAt: new Date().toISOString(),
  };
  return next;
}

export function addCapability(state, input) {
  const name = requiredText(input?.name, '能力名称不能为空');
  const questions = (input?.questions ?? []).map(question => String(question).trim()).filter(Boolean);
  const next = copyState(state);
  next.capabilities.push({
    id: createId('capability'),
    name,
    successDefinition: String(input?.successDefinition ?? '').trim(),
    questions,
    createdAt: new Date().toISOString(),
  });
  return next;
}

export function updateCapability(state, capabilityId, input) {
  const next = copyState(state);
  const index = next.capabilities.findIndex(capability => capability.id === capabilityId);
  if (index === -1) throw new Error('没有找到这项能力');

  const current = next.capabilities[index];
  next.capabilities[index] = {
    ...current,
    name: requiredText(input?.name, '能力名称不能为空'),
    successDefinition: String(input?.successDefinition ?? '').trim(),
    questions: (input?.questions ?? []).map(question => String(question).trim()).filter(Boolean),
    updatedAt: new Date().toISOString(),
  };
  return next;
}

export function deleteCapability(state, capabilityId) {
  const next = copyState(state);
  next.capabilities = next.capabilities.filter(capability => capability.id !== capabilityId);
  return next;
}

export function buildRuleStatement(triggerSituation, responseAction) {
  const trigger = requiredText(triggerSituation, '请写下触发场景');
  const action = requiredText(responseAction, '请写下下次的具体行动');
  return `当${trigger}发生时，我将${action}。`;
}

export function createReview(state, input) {
  const eventIds = [...new Set(input?.eventIds ?? [])].filter(Boolean);
  const subject = String(input?.subject ?? '').trim();
  if (eventIds.length === 0 && !subject) throw new Error('请写下要复盘的事，或选择一条记录');

  const next = copyState(state);
  const existingIds = new Set(next.events.map(event => event.id));
  if (eventIds.some(eventId => !existingIds.has(eventId))) throw new Error('选择的事情不存在');

  const capability = input?.capabilityId
    ? next.capabilities.find(item => item.id === input.capabilityId)
    : undefined;
  if (input?.capabilityId && !capability) throw new Error('选择的能力不存在');

  const mode = CORE_PROMPTS[input?.mode] ? input.mode : 'standard';
  const prompts = getPrompts(mode, capability);
  const answerValues = input?.answers ?? [];
  if (answerValues.length !== prompts.length || answerValues.some(answer => !String(answer ?? '').trim())) {
    throw new Error('请完成所有复盘问题');
  }

  const review = {
    id: createId('review'),
    subject,
    eventIds,
    mode,
    capabilityId: capability?.id ?? '',
    answers: prompts.map((prompt, index) => ({ prompt, answer: String(answerValues[index]).trim() })),
    triggerSituation: requiredText(input?.triggerSituation, '请写下触发场景'),
    responseAction: requiredText(input?.responseAction, '请写下下次的具体行动'),
    createdAt: new Date().toISOString(),
  };
  const rule = {
    id: createId('rule'),
    statement: buildRuleStatement(review.triggerSituation, review.responseAction),
    reviewId: review.id,
    createdAt: review.createdAt,
  };

  next.reviews.unshift(review);
  next.rules.unshift(rule);
  return next;
}
