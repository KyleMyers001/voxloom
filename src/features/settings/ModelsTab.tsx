import { useApp } from '../../app/AppContext';
import { useSttModels } from '../../services/stt/useSttModels';

/** Models tab (M1–M7). Markup and behavior unchanged from the old section; UI PR 7 restyles it and adds Retry. */
export function ModelsTab() {
  const { settings, state } = useApp();
  const {
    cancelDownload, downloadModel, error: sttError, loading: sttLoading, models: sttModels,
    progress: sttProgress, selectModel, selectedModelId,
  } = useSttModels({
    onSelect: (modelId) => settings.update({ key: 'transcriptionModel', value: modelId }),
    selectedModelId: state.settings.transcriptionModel,
  });

  return (
    <>
      <p className="empty-note">
        Local whisper models. Download only when you click Download —
        opening Settings or starting the app never fetches a model.
      </p>
      {sttLoading && <p className="empty-note" role="status">Loading model list…</p>}
      {sttError && <p className="form-error" role="alert">{sttError}</p>}
      <ul className="stt-model-list">
        {sttModels.map((model) => {
          const downloading = model.status === 'downloading' || sttProgress?.modelId === model.id;
          const selected = selectedModelId === model.id;
          const ratio = sttProgress?.modelId === model.id ? sttProgress.ratio : null;
          return (
            <li className="stt-model-row" key={model.id}>
              <label className="stt-model-select">
                <input
                  checked={selected}
                  name="stt-model"
                  onChange={() => selectModel(model.id)}
                  type="radio"
                  value={model.id}
                />
                <span>
                  <strong>{model.label}</strong>
                  <span className="stt-model-id">{model.id}</span>
                </span>
              </label>
              <span className="stt-model-status" data-status={model.status}>{model.status}</span>
              <div className="stt-model-actions">
                {downloading ? (
                  <>
                    <span className="stt-model-progress" role="status">
                      {ratio === null ? 'Downloading…' : `${Math.round(ratio * 100)}%`}
                    </span>
                    <button className="btn" onClick={() => { void cancelDownload(model.id); }} type="button">
                      Cancel download
                    </button>
                  </>
                ) : model.status === 'available' ? (
                  <span className="empty-note">On disk</span>
                ) : (
                  <button className="btn" onClick={() => { void downloadModel(model.id).catch(() => {}); }} type="button">
                    Download
                  </button>
                )}
              </div>
              {selected && (
                <p className="empty-note stt-model-selected-note">
                  Selected for transcription
                  {model.status !== 'available' ? ' · download required before dogfood STT' : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {!sttLoading && sttModels.length === 0 && <p className="empty-note">No models in catalog.</p>}
    </>
  );
}
