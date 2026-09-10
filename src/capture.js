export function changeCaptureType(draft, type) {
  return {
    content: String(draft?.content ?? ''),
    type: String(type ?? ''),
  };
}

export function captureDraftFromForm(form, draft) {
  return {
    content: String(form?.elements?.namedItem('content')?.value ?? draft?.content ?? ''),
    type: String(draft?.type ?? ''),
  };
}
