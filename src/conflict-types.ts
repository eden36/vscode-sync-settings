export type ConflictStrategy = 'cloud' | 'local' | 'ai';

export interface PendingConflictView {
  id: string;
  kind: 'pluginConfiguration' | 'profileSnapshot' | 'legacyConfigurationBackup';
  title: string;
  description: string;
  items: string[];
  aiCandidateReady: boolean;
  aiError?: string;
}

