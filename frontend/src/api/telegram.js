import http from './http';

export const telegramApi = {
  status: () => http.get('/telegram/status').then((r) => r.data),
  listChats: () => http.get('/telegram/chats').then((r) => r.data),
  updateChat: (id, payload) => http.put(`/telegram/chats/${id}`, payload).then((r) => r.data),
  removeChat: (id) => http.delete(`/telegram/chats/${id}`),
  testChat: (id) => http.post(`/telegram/chats/${id}/test`).then((r) => r.data),
};
