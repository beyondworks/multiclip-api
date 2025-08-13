export const ok = (res, data) => res.json(data);
export const err = (res, code, message) => res.status(code).json({ error: message });
