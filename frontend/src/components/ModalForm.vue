<script setup>
// Shared shell for every admin "create/edit in a modal" form (RegionForm,
// ProxyForm, UserForm, TelegramChatForm, ProxyImportForm) - these all had
// their own copy of the exact same Teleport+backdrop+card+h2+error+actions
// markup and CSS, differing only in their form fields and validation rules
// (which stay in each of those components, unchanged). Not a composable:
// the actual duplication here was markup/CSS, not stateful logic - each
// form's own `error` ref and handleSubmit validation were already only a
// couple of lines each and genuinely form-specific.
//
// Owns the <form> element itself and emits 'submit' on its native submit
// event, so pressing Enter in a slotted text input still works exactly as
// it did when each form had its own <form @submit.prevent>.
defineProps({
  title: { type: String, default: '' },
  error: { type: String, default: '' },
  maxWidth: { type: String, default: '560px' },
  cancelLabel: { type: String, default: 'Отмена' },
  submitLabel: { type: String, default: 'Сохранить' },
  submitDisabled: { type: Boolean, default: false },
});
const emit = defineEmits(['submit', 'cancel']);
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="emit('cancel')">
      <form class="card modal-card" :style="{ maxWidth }" @submit.prevent="emit('submit')">
        <!-- #header overrides the default <h2>title</h2> for forms that need
             more than a plain string there (TelegramChatForm's chat
             type/ID subtitle right under the heading). -->
        <slot name="header">
          <h2>{{ title }}</h2>
        </slot>

        <slot />

        <p v-if="error" class="error-text">{{ error }}</p>

        <div class="modal-actions">
          <button type="button" class="btn secondary" @click="emit('cancel')">{{ cancelLabel }}</button>
          <button type="submit" class="btn" :disabled="submitDisabled">{{ submitLabel }}</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

<style scoped>
/* Leaflet's own panes/controls use z-index up to 1000 and aren't contained
   in a stacking context, so they'd otherwise render above a lower z-index
   fixed overlay like this one - keep this comfortably above that. */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 16px;
  overflow-y: auto;
  z-index: 2000;
}

.modal-card {
  width: 100%;
}

.modal-card h2 {
  margin-top: 0;
  font-size: 18px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
