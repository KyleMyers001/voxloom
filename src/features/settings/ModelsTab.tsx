import { useApp } from '../../app/AppContext';
import { Banner } from '../../components/Banner';
import { EmptyState } from '../../components/EmptyState';
import { failureRowCopy, useSttModels } from '../../services/stt/useSttModels';
import { ModelCard } from './ModelCard';

/** Models tab (M1–M7, UI PR 7): model cards, progress, Retry download, list-error Try again. */
export function ModelsTab() {
  const { settings, state } = useApp();
  const stt = useSttModels({
    onSelect: (modelId) => settings.update({ key: 'transcriptionModel', value: modelId }),
    selectedModelId: state.settings.transcriptionModel,
  });
  // Download/Retry rejections are shown on the row; nothing here downloads on its own.
  // BUS-52: one download at a time; the other cards' Download buttons wait.
  const busy = stt.progress !== null || stt.models.some((m) => m.status === 'downloading');
  const start = (id: string) => { void stt.downloadModel(id).catch(() => {}); };

  return (
    <>
      <p className="empty-note">
        Local Whisper models. Nothing downloads until you click Download,
        not when the app opens or Settings is shown.
      </p>
      {stt.loading && <p className="empty-note" role="status">Loading model list…</p>}
      {stt.listError && (
        <Banner
          action={<button className="btn" onClick={() => { void stt.reload(); }} type="button">Try again</button>}
          tone="error"
        >
          Couldn’t load the model list. {stt.listError}
        </Banner>
      )}
      {stt.error && <p className="form-error" role="alert">{stt.error}</p>}
      <ul className="stt-model-list">
        {stt.models.map((model) => (
          <ModelCard
            failure={stt.failures[model.id] ?? failureRowCopy(model.failureReason)}
            key={model.id}
            model={model}
            onCancel={() => { void stt.cancelDownload(model.id).catch(() => {}); }}
            downloadLocked={busy && stt.progress?.modelId !== model.id && model.status !== 'downloading'}
            onDownload={() => start(model.id)}
            onSelect={() => stt.selectModel(model.id)}
            progress={stt.progress?.modelId === model.id ? stt.progress : null}
            selected={stt.selectedModelId === model.id}
          />
        ))}
      </ul>
      {!stt.loading && !stt.listError && stt.models.length === 0 && (
        <EmptyState icon="down" title="No models in catalog." />
      )}
    </>
  );
}
