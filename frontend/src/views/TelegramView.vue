<script setup>
import { computed, onMounted, ref } from 'vue';
import { telegramApi } from '../api/telegram';
import { regionsApi } from '../api/regions';
import TelegramChatForm from '../components/TelegramChatForm.vue';

const status = ref(null);
const chats = ref([]);
const regions = ref([]);
const loading = ref(true);
const errorMessage = ref('');
const showForm = ref(false);
const editingChat = ref(null);
const testingIds = ref(new Set());

const STATUS_LABELS = {
  pending: 'ожидает настройки',
  active: 'активен',
  disabled: 'отключён',
};

const TYPE_LABELS = {
  private: 'личный чат',
  group: 'группа',
  supergroup: 'супергруппа',
  channel: 'канал',
};

const botStatusText = computed(() => {
  if (!status.value) return '';
  if (!status.value.enabled) return 'Бот не настроен (не задан TELEGRAM_BOT_TOKEN)';
  if (!status.value.running) return 'Бот включён, но не запущен (см. логи бэкенда)';
  return `Бот запущен: @${status.value.username}`;
});

async function loadAll() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const [statusRes, chatsRes, regionsRes] = await Promise.all([
      telegramApi.status(),
      telegramApi.listChats(),
      regionsApi.list(),
    ]);
    status.value = statusRes;
    chats.value = chatsRes;
    regions.value = regionsRes;
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось загрузить данные Telegram-бота';
  } finally {
    loading.value = false;
  }
}

function openEditForm(chat) {
  editingChat.value = chat;
  showForm.value = true;
}

async function handleSubmit(payload) {
  errorMessage.value = '';
  try {
    await telegramApi.updateChat(editingChat.value.id, payload);
    showForm.value = false;
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось сохранить настройки чата';
  }
}

async function handleDelete(chat) {
  if (!confirm(`Удалить чат «${chat.title || chat.chatId}» из списка?`)) return;
  errorMessage.value = '';
  try {
    await telegramApi.removeChat(chat.id);
    await loadAll();
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось удалить чат';
  }
}

async function handleTest(chat) {
  testingIds.value.add(chat.id);
  errorMessage.value = '';
  try {
    await telegramApi.testChat(chat.id);
  } catch (err) {
    errorMessage.value = err.response?.data?.error || 'Не удалось отправить тестовое сообщение';
  } finally {
    testingIds.value.delete(chat.id);
  }
}

function eventsSummary(chat) {
  const labels = [];
  if (chat.events.stationAvailable || chat.events.stationUnavailable) labels.push('топливо');
  if (chat.events.hourlyDigest) labels.push('часовая сводка');
  if (chat.events.dailyDigest) labels.push('дневная сводка');
  return labels.length ? labels.join(', ') : '—';
}

function regionsSummary(chat) {
  if (!chat.regions.length) return '—';
  return chat.regions.map((r) => r.name || r.id).join(', ');
}

onMounted(loadAll);
</script>

<template>
  <div>
    <div class="page-header">
      <h1>Telegram-бот</h1>
    </div>

    <p class="hint">
      Добавьте бота в чат или группу и отправьте ему любое сообщение — чат появится здесь со
      статусом «ожидает настройки». Уведомления в чат начинают приходить только после того, как
      администратор переведёт его в статус «активен» и настроит районы/события.
    </p>

    <p v-if="status" class="hint bot-status" :class="{ warn: !status.running }">
      {{ botStatusText }}
    </p>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

    <div class="card">
      <p v-if="loading">Загрузка...</p>
      <p v-else-if="!chats.length">
        Пока нет ни одного чата. Добавьте бота в Telegram-чат и напишите ему что-нибудь.
      </p>
      <div v-else class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Чат</th>
              <th>Тип</th>
              <th>Статус</th>
              <th>Районы</th>
              <th>События</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in chats" :key="c.id">
              <td>
                {{ c.title || c.chatId }}
                <div class="sub-note mono">{{ c.chatId }}</div>
              </td>
              <td>{{ TYPE_LABELS[c.type] || c.type }}</td>
              <td>
                <span class="badge" :class="c.status === 'active' ? 'ok' : c.status === 'disabled' ? 'error' : 'never'">
                  {{ STATUS_LABELS[c.status] || c.status }}
                </span>
              </td>
              <td>{{ regionsSummary(c) }}</td>
              <td>{{ eventsSummary(c) }}</td>
              <td class="actions">
                <button
                  class="btn secondary"
                  :disabled="testingIds.has(c.id) || c.status !== 'active'"
                  :title="c.status !== 'active' ? 'Доступно только для активных чатов' : ''"
                  @click="handleTest(c)"
                >
                  {{ testingIds.has(c.id) ? 'Отправка...' : 'Тест' }}
                </button>
                <button class="btn secondary" @click="openEditForm(c)">Настроить</button>
                <button class="btn danger" @click="handleDelete(c)">Удалить</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <TelegramChatForm
      v-if="showForm"
      :initial="editingChat"
      :regions="regions"
      @submit="handleSubmit"
      @cancel="showForm = false"
    />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-header h1 {
  font-size: 20px;
  margin: 0;
}

.hint {
  color: #64748b;
  font-size: 13px;
  margin: -8px 0 16px;
  max-width: 720px;
}

.bot-status {
  font-weight: 600;
}

.bot-status.warn {
  color: #b45309;
}

.table-wrap {
  overflow-x: auto;
}

.mono {
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}

.sub-note {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
