<script setup>
import { computed, defineAsyncComponent } from 'vue'
import { storeToRefs } from 'pinia'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { useWorkflowsStore } from '../../stores/useWorkflowsStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useModalsStore } from '../../stores/useModalsStore.js'
import { useTheme } from '../../composables/useTheme.js'
import { useAppContext } from '../../appContext.js'
import AboutModal from '../modals/AboutModal.vue'
import ConfirmModal from '../modals/ConfirmModal.vue'
import FolderReconnectModal from '../modals/FolderReconnectModal.vue'
import NewProjectModal from '../modals/NewProjectModal.vue'
import ProgressModal from '../modals/ProgressModal.vue'
import ProjectPicker from '../layout/ProjectPicker.vue'
import ProjectSettingsModal from '../modals/ProjectSettingsModal.vue'
import SaveProjectModal from '../modals/SaveProjectModal.vue'
import SettingsModal from '../modals/SettingsModal.vue'
const DebugSummaryModal = defineAsyncComponent(() => import('../modals/DebugSummaryModal.vue'))
const SystemInfoModal = defineAsyncComponent(() => import('../modals/SystemInfoModal.vue'))
const WorkflowBuilderModal = defineAsyncComponent(() => import('../modals/WorkflowBuilderModal.vue'))

// The project-level dialogs, lifted out of App.vue: the project picker and its
// load overlay, the workflow builder, settings, the shared confirm dialogs and the
// pipeline progress bar. The workflow builder comes first in DOM order: an
// interactive workflow block opens its own dialog above it, then returns here.
const { currentProject, currentProjectId, currentProjectName, projects } = storeToRefs(useProjectsStore())
const { folderSupported, renameProject } = useProjectsStore()
const { activeId: activeWorkflowId, runs: workflowRuns, templates: workflowTemplates, workflows } = storeToRefs(useWorkflowsStore())
const { applyTemplate: applyWorkflowTemplate, duplicateWorkflow, removeWorkflow, removeTemplate: removeWorkflowTemplate, saveTemplate: saveWorkflowTemplate, setActive: setActiveWorkflow } = useWorkflowsStore()
const reconstructionStore = useReconstructionStore()
const { crsSuggestion, liveSparse } = storeToRefs(reconstructionStore)
const {
  aboutOpen, debugSummaryOpen, newProjectCanCancel, newProjectOpen, projectPickerOpen, projectSettingsOpen,
  saveProjectOpen, settingsOpen, systemInfoOpen, workflowBuilderOpen,
} = storeToRefs(useModalsStore())
const { setTheme, theme, themePreference } = useTheme()
const {
  addNewWorkflow, applyCrsSuggestion, cancelPendingConfirm, cancelRun, clearCurrentProjectDerived,
  closeWorkflowBuilder, confirmRemoveImages, deleteMessage, folderPrompt, folderPromptProject,
  handleCancelNewProject, handleCreateProject, handleDeleteProject, handleSetCrs, handleSwitchProject,
  moveCurrentProjectToBrowser, moveCurrentProjectToFolder, onFolderConnect, onFolderRepick, onSaveProject,
  onWorkflowRun, onWorkflowUpdate, openProjectFolder, pendingConfirm, pendingImageDelete,
  pickProjectFile, progressCancelling, progressComplete, progressCurrent, progressFraction,
  progressIndeterminate, progressLabel, progressOpen, progressTitle, progressTotal,
  progressUnit, projectLoading, projectLoadingLabel, projectLoadingProgress, runPendingConfirm,
  workflowCurrentBlockId, workflowPause, workflowRunner, workflowRunning, workflowState,
  workflowStatuses, activeTabId,
} = useAppContext()
// A sparse run draws its model as it grows (liveSparse): over the 3D view, the bar
// moves to a corner and stops dimming the scene.
const progressDocked = computed(() => !!liveSparse.value && activeTabId.value === 'viewer')
</script>

<template>
  <div v-if="projectPickerOpen && !currentProjectId" class="project-backdrop" />


  <div v-if="projectLoading" class="loading-overlay">
    <div class="loading-card">
      <div class="loading-spinner" />
      <div class="loading-text">
        <span>{{ projectLoadingLabel }}</span>
        <template v-if="projectLoadingProgress">
          <span class="loading-detail">
            {{ projectLoadingProgress.label }}<template v-if="projectLoadingProgress.total">
              ({{ projectLoadingProgress.done }}/{{ projectLoadingProgress.total }})</template>
          </span>
          <progress v-if="projectLoadingProgress.total" class="loading-bar"
            :max="projectLoadingProgress.total" :value="projectLoadingProgress.done" />
          <span v-if="projectLoadingProgress.detail" class="loading-detail">{{ projectLoadingProgress.detail }}</span>
        </template>
      </div>
    </div>
  </div>


  <ProjectPicker
    v-if="projectPickerOpen"
    :projects="projects"
    :current-project-id="currentProjectId"
    :dismissible="!!currentProjectId"
    :folder-supported="folderSupported"
    @switch="handleSwitchProject"
    @rename="(id, name) => renameProject(id, name)"
    @delete="handleDeleteProject"
    @new="() => { projectPickerOpen = false; newProjectCanCancel = true; newProjectOpen = true }"
    @open-file="pickProjectFile"
    @open-folder="() => { projectPickerOpen = false; openProjectFolder() }"
    @save-copy="() => { projectPickerOpen = false; saveProjectOpen = true }"
    @move-to-folder="(id) => { projectPickerOpen = false; moveCurrentProjectToFolder(id) }"
    @move-to-browser="(id) => { projectPickerOpen = false; moveCurrentProjectToBrowser(id) }"
    @settings="() => { projectPickerOpen = false; projectSettingsOpen = true }"
    @close="projectPickerOpen = false"
  />


  <!-- Kept before the command modals in DOM order: an interactive workflow block
       opens its existing modal above the builder, then returns here to continue. -->
  <Teleport to="body">
    <WorkflowBuilderModal
      v-if="workflowBuilderOpen"
      :workflows="workflows"
      :active-id="activeWorkflowId"
      :templates="workflowTemplates"
      :runs="workflowRuns"
      :state="workflowState"
      :running="workflowRunning"
      :pause="workflowPause"
      :statuses="workflowStatuses"
      :current-block-id="workflowCurrentBlockId"
      @close="closeWorkflowBuilder"
      @set-active="setActiveWorkflow"
      @add-workflow="addNewWorkflow"
      @update-workflow="onWorkflowUpdate"
      @duplicate-workflow="duplicateWorkflow"
      @remove-workflow="removeWorkflow"
      @save-template="saveWorkflowTemplate"
      @apply-template="applyWorkflowTemplate"
      @remove-template="removeWorkflowTemplate"
      @run="onWorkflowRun"
      @respond="workflowRunner.respond"
      @stop="workflowRunner.stop"
    />
  </Teleport>


  <Teleport to="body">
    <ConfirmModal
      v-if="pendingImageDelete"
      :title="pendingImageDelete.ids.length > 1 ? 'Remove images?' : 'Remove image?'"
      :message="deleteMessage"
      confirm-label="Remove"
      danger
      @confirm="confirmRemoveImages"
      @cancel="pendingImageDelete = null"
    />
  </Teleport>


  <Teleport to="body">
    <ConfirmModal
      v-if="pendingConfirm"
      :title="pendingConfirm.title"
      :message="pendingConfirm.message"
      :confirm-label="pendingConfirm.confirmLabel || 'Remove'"
      :cancel-label="pendingConfirm.cancelLabel || 'Cancel'"
      :dont-ask="!!pendingConfirm.onDontAsk"
      :danger="pendingConfirm.danger ?? true"
      @confirm="runPendingConfirm"
      @cancel="cancelPendingConfirm"
    />
  </Teleport>


  <Teleport to="body">
    <ProgressModal
      v-if="progressOpen"
      :title="progressTitle"
      :current="progressCurrent"
      :total="progressTotal"
      :label="progressLabel"
      :unit="progressUnit"
      :fraction="progressFraction"
      :indeterminate="progressIndeterminate"
      :complete="progressComplete"
      :cancelling="progressCancelling"
      :cancelable="true"
      :docked="progressDocked"
      @cancel="cancelRun"
    />
  </Teleport>


  <Teleport to="body">
    <SettingsModal
      v-if="settingsOpen"
      :theme="themePreference"
      :resolved-theme="theme"
      @close="settingsOpen = false"
      @set-theme="setTheme"
    />
    <ProjectSettingsModal
      v-if="projectSettingsOpen && currentProject"
      :project="currentProject"
      :clear-derived="clearCurrentProjectDerived"
      @close="projectSettingsOpen = false"
      @rename="(name) => renameProject(currentProjectId, name)"
      :crs-suggestion="crsSuggestion"
      @set-crs="handleSetCrs"
      @apply-crs-suggestion="applyCrsSuggestion"
    />
  </Teleport>


  <Teleport to="body">
    <AboutModal v-if="aboutOpen" @close="aboutOpen = false" />
    <SystemInfoModal v-if="systemInfoOpen" @close="systemInfoOpen = false" />
  </Teleport>


  <Teleport to="body">
    <NewProjectModal
      v-if="newProjectOpen"
      :can-cancel="newProjectCanCancel"
      @create="handleCreateProject"
      @cancel="handleCancelNewProject"
    />
  </Teleport>


  <Teleport to="body">
    <FolderReconnectModal
      v-if="folderPrompt"
      :project-name="folderPromptProject?.name || 'This project'"
      :folder-name="folderPromptProject?.folderName || ''"
      :mode="folderPrompt.action === 'repick' ? 'repick' : 'prompt'"
      :error="folderPrompt.error"
      @connect="onFolderConnect"
      @repick="onFolderRepick"
      @cancel="folderPrompt = null"
    />
  </Teleport>


  <Teleport to="body">
    <SaveProjectModal
      v-if="saveProjectOpen && currentProjectId"
      :project-id="currentProjectId"
      :project-name="currentProjectName"
      @close="saveProjectOpen = false"
      @run="onSaveProject"
    />
  </Teleport>


  <Teleport to="body">
    <DebugSummaryModal v-if="debugSummaryOpen" @close="debugSummaryOpen = false" />
  </Teleport>
</template>

<style scoped>
.project-backdrop {
  position: fixed;
  inset: 0;
  z-index: 299;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* Interaction-blocking overlay shown while a project restores. */
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 400;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
}

.loading-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 22px;
  border-radius: 10px;
  background: var(--panel, #1e1e24);
  color: var(--text, #e8e8ec);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
  font-size: 14px;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  flex: none;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--accent, #44aaff);
  border-radius: 50%;
  animation: loading-spin 0.8s linear infinite;
}

.loading-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.loading-detail {
  font-size: 12px;
  color: var(--text-dim, #9a9aa4);
}

.loading-bar {
  width: 280px;
  height: 6px;
  appearance: none;
  border: none;
  border-radius: 3px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.12);
}

.loading-bar::-webkit-progress-bar { background: rgba(255, 255, 255, 0.12); }

.loading-bar::-webkit-progress-value { background: var(--accent, #44aaff); }

.loading-bar::-moz-progress-bar { background: var(--accent, #44aaff); }
@keyframes loading-spin {
  to { transform: rotate(360deg); }
}
</style>
