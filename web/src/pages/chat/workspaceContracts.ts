// Frozen contracts between the chat workspace packages (BUILD-SPEC-B §5.1, §9). Created by WP0; change only by agreement.
// WP1 (thread, layout) consumes ChatMap and ChatInspector; WP2 implements ChatMap + SeatPanel; WP3 implements ChatInspector.
import type { JSX, ReactNode } from 'react';
import type { AgentTask, ChatCapabilities, ChatRecord, ChatStream, DriverCapability } from '../../lib/chat-api';
import type { ToolEvidence } from './chatModel';
import type { Observatory } from './observatoryModel';
import type { RotationNotice } from './PipelineStatus';

// ---------- map pane (WP2) ----------
export type MapVariant = 'docked' | 'full';

export interface ChatMapProps {
  /** buildObservatory(chat, capabilities, activityTools, rotations, fixedDemo), built ONCE in ChatPage. */
  model: Observatory;
  chat: ChatRecord | null;
  variant: MapVariant;
  /** Fixed-demo chat → stage caption tag `▷ 预设演示`. */
  demo: boolean;
  /** True only when the last reducer origin ∈ {'event','chat','demo'} (never 'snapshot'/'initial'). */
  animateChanges: boolean;
  /** fixedDemo ? !demoPaused : connection === 'live'. */
  canFlow: boolean;
  welcome?: { ready: number; unavailable: { role: string; reason: string }[]; previewPipeline: boolean };
  /** <PipelineRail/> from WP1, rendered in the 68px row between head and stage. */
  rail?: ReactNode;
  /** <ChatInspector placement="dock"/> from WP1/WP3, rendered under the stage, outside `.observatory`. */
  dock?: ReactNode;
  dockOpen: boolean;
  /** fits = deckH − 40 − railH − 330 ≥ 150. */
  onDockFit(fits: boolean, deckH: number): void;
  onToggleMax(): void;
  onCollapse(): void;
  /** ◆ clicked on the map or rail → WP1 scrolls to the gate card and focuses 确认继续. */
  onGateNode(): void;
}

/** pages/chat/ChatMap.tsx default export. */
export type ChatMapComponent = (props: ChatMapProps) => JSX.Element;

export interface SeatPanelProps { model: Observatory; seat?: string }
/** pages/chat/ObservatorySeatPanel.tsx named export `SeatPanel`. */
export type SeatPanelComponent = (props: SeatPanelProps) => JSX.Element;

// ---------- inspector 协作详情 (WP3) ----------
export type InspectorTab = 'seat' | 'tasks' | 'files' | 'context' | 'settings';
export type InspectorPlacement = 'dock' | 'column';
/** Default tab is 任务 (QA scripts and the old reset behaviour). */
export const DEFAULT_INSPECTOR_TAB: InspectorTab = 'tasks';

export interface ChatInspectorProps {
  chat: ChatRecord;
  streams: ChatStream[];
  tools: ToolEvidence[];
  rotations: RotationNotice[];
  /** Per-chat driver capabilities from the snapshot. */
  capabilities: DriverCapability[];
  /** GET /api/chat-capabilities (exec, services, apiConfiguration); null until loaded. */
  globalCapabilities: ChatCapabilities | null;
  model: Observatory;
  fixedDemo: boolean;
  /** The tab is lifted to ChatPage, so a dock↔column remount keeps it. */
  tab: InspectorTab;
  onTab(tab: InspectorTab): void;
  placement: InspectorPlacement;
  /** Dock only: collapsed to its 38px tab bar. */
  collapsed?: boolean;
  onCollapse?(collapsed: boolean): void;
  onClose(): void;
}

/** pages/chat/ChatInspector.tsx default export. */
export type ChatInspectorComponent = (props: ChatInspectorProps) => JSX.Element;

// ---------- new optional ChatPanels props (WP1 implements; WP3 consumes) ----------
/** ArtifactList: seat attribution from artifact.taskId → task.role (§4.5). */
export interface ArtifactListExtraProps { tasks?: AgentTask[] }
/** AttachmentList: seat chip for source:'generated' attachments (attachment.taskId → task.role). */
export interface AttachmentListExtraProps { tasks?: AgentTask[] }
/** TaskTree: goals clamped to 2 lines + an `展开全文` toggle (inspector 任务 tab). */
export interface TaskTreeExtraProps { clampGoals?: boolean }
/** ActivityList: the lead seat label shown in `{lead} → ● {Seat}` rows. */
export interface ActivityListExtraProps { lead?: string }
