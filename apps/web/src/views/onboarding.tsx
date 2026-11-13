import { ViewHead, Empty } from "../ui/primitives";

/** Placeholder: this screen is ported from legacy/js/views/onboarding.js in a later wave. */
export default function OnboardingView() {
  return (
    <div className="view">
      <ViewHead kicker="Onboarding" title="Onboarding" />
      <Empty title="Onboarding" text="Ported in a later wave" />
    </div>
  );
}
