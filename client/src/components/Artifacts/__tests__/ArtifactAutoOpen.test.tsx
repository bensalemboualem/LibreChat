/**
 * Régression — auto-open du panneau artifacts pour le chemin markdown
 * (`:::artifact`), pendant le streaming.
 *
 * Monte les VRAIS modules dans une réplique fidèle de l'arbre de prod :
 *   - Artifact (composant markdown, enregistre dans artifactsState)
 *   - useAutoOpenArtifactPanel + useResetArtifactsOnConversationChange
 *     (toujours montés, niveau Presentation)
 *   - le gate de Presentation.tsx (visibility && currentArtifactId &&
 *     artifacts non vide) devant un hôte qui monte le VRAI useArtifacts
 *
 * Couvre notamment la course historique : le panneau s'ouvrait puis les
 * resets « changement de conversation » (assignation d'identité
 * new/PENDING → id réel pendant le stream) le refermaient définitivement.
 */
import React, { useEffect } from 'react';
import { MemoryRouter } from 'react-router-dom';
import {
  RecoilRoot,
  useRecoilValue,
  useSetRecoilState,
  useResetRecoilState,
  type MutableSnapshot,
} from 'recoil';
import { render, act } from '@testing-library/react';

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  // le harnais rend l'Artifact hors vraie route : force la branche /c/*
  isArtifactRoute: () => true,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Input/Files/FilePreview', () => ({
  __esModule: true,
  default: () => <div data-testid="file-preview" />,
}));

/**
 * Miroir de ArtifactsContext.tsx : le vrai provider lit
 * isSubmittingFamily(0) et conversationIdByIndex(0) dans recoil ;
 * latestMessageId/Text viennent de useLatestMessage (piloté ici par
 * globals pour ne pas tirer toute la chaîne messages).
 */
jest.mock('~/Providers', () => {
  const { useRecoilValue: useRV } = require('recoil');
  const realStore = require('~/store').default;
  return {
    useMessageContext: () => ({ messageId: (globalThis as any).__testMsgId ?? 'msg-1' }),
    useArtifactContext: () => ({ getNextIndex: () => 0, resetCounter: () => {} }),
    useArtifactsContext: () => {
      const isSubmitting = useRV(realStore.isSubmittingFamily(0));
      const conversationId = useRV(realStore.conversationIdByIndex(0));
      return {
        isSubmitting,
        conversationId: conversationId ?? null,
        latestMessageId: (globalThis as any).__testMsgId ?? 'msg-1',
        latestMessageText: (globalThis as any).__testLatestText ?? '',
      };
    },
  };
});

import { Artifact } from '~/components/Artifacts/Artifact';
import useArtifacts from '~/hooks/Artifacts/useArtifacts';
import useAutoOpenArtifactPanel from '~/hooks/Artifacts/useAutoOpenArtifactPanel';
import useResetArtifactsOnConversationChange from '~/hooks/Artifacts/useResetArtifactsOnConversationChange';
import store from '~/store';

/** Corps du panneau : monte le VRAI useArtifacts, comme Artifacts.tsx. */
const PanelHost = () => {
  useArtifacts();
  return <div data-testid="artifacts-panel" />;
};

/** Réplique du gate + hooks toujours montés de Presentation.tsx. */
const PresentationGate = () => {
  const artifacts = useRecoilValue(store.artifactsState);
  const artifactsVisibility = useRecoilValue(store.artifactsVisibility);
  const currentArtifactId = useRecoilValue(store.currentArtifactId);
  useResetArtifactsOnConversationChange();
  useAutoOpenArtifactPanel();
  const open =
    artifactsVisibility === true &&
    currentArtifactId != null &&
    Object.keys(artifacts ?? {}).length > 0;
  return open ? <PanelHost /> : null;
};

interface Controls {
  setConvo: (id: string) => void;
  setSubmitting: (value: boolean) => void;
  userClosePanel: () => void;
}
let controls: Controls;

const CaptureControls = () => {
  const setConvoAtom = useSetRecoilState(store.conversationByIndex(0));
  const setSubmitting = useSetRecoilState(store.isSubmittingFamily(0));
  const setVisible = useSetRecoilState(store.artifactsVisibility);
  const resetCurrent = useResetRecoilState(store.currentArtifactId);
  controls = {
    setConvo: (id) => setConvoAtom({ conversationId: id } as any),
    setSubmitting,
    // reproduit le click-to-close de ArtifactButton.tsx
    userClosePanel: () => {
      resetCurrent();
      setVisible(false);
    },
  };
  return null;
};

const Harness = ({ chunk, type = 'text/html' }: { chunk: string | null; type?: string }) => (
  <MemoryRouter initialEntries={['/c/new']}>
    <CaptureControls />
    <PresentationGate />
    {chunk != null && (
      <Artifact node={undefined} identifier="memo" type={type} title="Mémo" {...({} as any)}>
        {chunk}
      </Artifact>
    )}
  </MemoryRouter>
);

const renderHarness = (init: { convo: string; submitting: boolean }) => {
  const initializeState = (snap: MutableSnapshot) => {
    snap.set(store.conversationByIndex(0), { conversationId: init.convo } as any);
    snap.set(store.isSubmittingFamily(0), init.submitting);
  };
  const utils = render(
    <RecoilRoot initializeState={initializeState}>
      <Harness chunk={null} />
    </RecoilRoot>,
  );
  const setChunk = (chunk: string | null, type?: string) =>
    utils.rerender(
      <RecoilRoot initializeState={initializeState}>
        <Harness chunk={chunk} type={type} />
      </RecoilRoot>,
    );
  return { ...utils, setChunk };
};

/** L'enregistrement dans Artifact.tsx est throttlé à 25 ms. */
const flushThrottle = () =>
  act(() => {
    jest.advanceTimersByTime(30);
  });

const panelOpen = (queryByTestId: (id: string) => HTMLElement | null) =>
  queryByTestId('artifacts-panel') != null;

describe('auto-open du panneau pour les artifacts markdown en streaming', () => {
  let msgCounter = 0;
  beforeEach(() => {
    jest.useFakeTimers();
    // messageId unique par test : la clé d'artifact en dépend
    (globalThis as any).__testMsgId = `msg-${++msgCounter}`;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("s'ouvre seul pendant le stream quand l'id de conversation est déjà assigné", () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'new', submitting: false });

    act(() => controls.setSubmitting(true));
    act(() => controls.setConvo('conv-A')); // created event avant l'artifact

    act(() => setChunk('<html><body><h1>Mandat'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);

    act(() => setChunk('<html><body><h1>Mandat restaurant</h1><p>Art. 1</p></body></html>'));
    flushThrottle();
    act(() => controls.setSubmitting(false)); // finalize
    expect(panelOpen(queryByTestId)).toBe(true);
  });

  it("survit à l'assignation d'identité new → id pendant le stream (course historique)", () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'new', submitting: true });

    act(() => setChunk('<html><body><h1>Mandat')); // artifact avant le created event
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);

    act(() => controls.setConvo('conv-B')); // created event après coup
    act(() => setChunk('<html><body><h1>Mandat restaurant</h1>'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);
  });

  it("survit à la chaîne new → PENDING → id pendant le stream", () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'new', submitting: true });

    act(() => setChunk('<html><body><h1>Doc'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);

    act(() => controls.setConvo('PENDING'));
    act(() => setChunk('<html><body><h1>Doc</h1><p>a'));
    flushThrottle();
    act(() => controls.setConvo('conv-C'));
    act(() => setChunk('<html><body><h1>Doc</h1><p>ab'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);
  });

  it('respecte la fermeture manuelle pour le reste du stream, puis ré-arme au message suivant', () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'conv-D', submitting: true });

    act(() => setChunk('<html><body><h1>Doc'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);

    act(() => controls.userClosePanel());
    expect(panelOpen(queryByTestId)).toBe(false);

    act(() => setChunk('<html><body><h1>Doc</h1><p>la suite du stream'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(false); // pas de réouverture forcée

    // nouveau message : l'auto-open se ré-arme
    act(() => controls.setSubmitting(false));
    (globalThis as any).__testMsgId = `msg-${++msgCounter}-bis`;
    act(() => controls.setSubmitting(true));
    act(() => setChunk('<html><body><h1>Nouveau doc'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(true);
  });

  it("ne s'ouvre pas au chargement d'un historique (pas de stream en cours)", () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'conv-E', submitting: false });

    act(() => setChunk('<html><body><h1>Vieux document</h1></body></html>'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(false);
  });

  it("ne s'ouvre pas pour un artifact code-only (click-to-open préservé)", () => {
    const { queryByTestId, setChunk } = renderHarness({ convo: 'conv-F', submitting: true });

    act(() => setChunk('print("hello")', 'application/vnd.code'));
    flushThrottle();
    expect(panelOpen(queryByTestId)).toBe(false);
  });
});
