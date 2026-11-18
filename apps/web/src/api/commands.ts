/**
 * The write commands the Projects, Onboarding and Project config screens run. Views take a command from here and run it through
 * `useCommand` (or the `useRes` toast helper); they do not import `api/ops` themselves.
 */
import { ops } from "./ops";

export const commands = {
  createProject: ops.createProject,
  connectRepo: ops.connectRepo,
  rerunAssessment: ops.rerunAssessment,
  openOnboardingPR: ops.openOnboardingPR,
  mergeOnboardingPR: ops.mergeOnboardingPR,
  saveGuidelines: ops.saveGuidelines,
  setProject: ops.setProject,
  setGateMode: ops.setGateMode,
  kill: ops.kill,
  haltProject: ops.haltProject,
  attachSkill: ops.attachSkill,
  setSkillProjects: ops.setSkillProjects,
  editBrief: ops.editBrief,
  sendBack: ops.sendBack,
};
