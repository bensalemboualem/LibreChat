import { useEffect, useRef } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import { isCodeOnlyArtifact } from '~/utils/artifacts';
import store from '~/store';

/**
 * Auto-opens the artifacts side panel while a response streams — the
 * markdown-artifact counterpart of `ToolArtifactCard`'s mount-time focus
 * effect. `Presentation` gates the panel on `currentArtifactId != null`,
 * and `useArtifacts` (which owns auto-selection) only runs while the
 * panel is mounted — so without an always-mounted trigger, a streamed
 * `:::artifact` can never open a closed panel (chicken-and-egg).
 *
 * Rules:
 * - Only reacts to artifacts REGISTERED during the current submission:
 *   pre-existing ids are snapshotted on the false→true edge of
 *   `isSubmitting`, so history renders and page loads never open the
 *   panel, and neither does a new submission that has produced no
 *   artifact yet.
 * - Force-opens once per submission. Closing the panel mid-stream sets
 *   `artifactsVisibility` to false (see `ArtifactButton`'s click-to-close),
 *   which this hook respects for the rest of that submission; the next
 *   submission re-arms auto-open.
 * - System resets (conversation-id assignment wiping `artifactsState` /
 *   `currentArtifactId`) never touch `artifactsVisibility`, so a wiped
 *   focus is repaired on the next artifact update instead of being
 *   mistaken for a user close.
 * - Code-only artifacts stay click-to-open, mirroring `ToolArtifactCard`
 *   and `useArtifacts`'s own auto-selection.
 */
export default function useAutoOpenArtifactPanel(): void {
  const artifacts = useRecoilValue(store.artifactsState);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const visibility = useRecoilValue(store.artifactsVisibility);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);

  const wasSubmittingRef = useRef(false);
  const preexistingIdsRef = useRef<Set<string>>(new Set());
  const hasOpenedThisSubmissionRef = useRef(false);

  useEffect(() => {
    if (isSubmitting && !wasSubmittingRef.current) {
      preexistingIdsRef.current = new Set(Object.keys(artifacts ?? {}));
      hasOpenedThisSubmissionRef.current = false;
    }
    wasSubmittingRef.current = isSubmitting;

    if (!isSubmitting) {
      return;
    }

    const fresh = Object.values(artifacts ?? {})
      .filter(
        (artifact): artifact is NonNullable<typeof artifact> =>
          artifact != null &&
          !preexistingIdsRef.current.has(artifact.id) &&
          !isCodeOnlyArtifact(artifact.type),
      )
      .sort((a, b) => (a.lastUpdateTime ?? 0) - (b.lastUpdateTime ?? 0));

    const target = fresh[fresh.length - 1];
    if (target == null) {
      return;
    }

    if (!hasOpenedThisSubmissionRef.current) {
      hasOpenedThisSubmissionRef.current = true;
      setCurrentArtifactId(target.id);
      setVisible(true);
      return;
    }

    // Already opened this submission: only repair a system reset
    // (visibility still true but focus wiped). A user close set
    // visibility=false and stays respected until the next submission.
    if (visibility === true && currentArtifactId == null) {
      setCurrentArtifactId(target.id);
    }
  }, [artifacts, isSubmitting, visibility, currentArtifactId, setCurrentArtifactId, setVisible]);
}
