# Trim corpus (BUS-143)

16 kHz mono signed 16-bit little-endian PCM, 11 clips, 1.6 MB. Used by
`trim_corpus_tests.rs` (every CI run, no model) and
`trim_corpus_model_tests.rs` (needs a Whisper model, `#[ignore]`).

Source: the LibriSpeech ASR corpus (OpenSLR 12, CC BY 4.0), the
`librispeech_asr_dummy` clips. No personal recordings. Clip names keep the
corpus' speaker-chapter-utterance numbers. Every clip is cut to its last
3 s of speech (`trailoff`: its last 4.5 s) so the files stay small.

- `trailoff` (`*_d<ms>_A<dB>`): a clip that ends in speech, with no pause
  after it. Its last `<ms>` is attenuated `<dB>` below its own level and
  −60 dBFS Gaussian room noise is added. Nothing follows, so the whole
  clip is speech and all of it must be kept. At ff8de7a the trim cut
  0.8–1.5 s of it and Whisper dropped the last words.
  `expected_word` is a word the model hears on the untrimmed clip
  (base.en); it is the one the cut lost.
- `halluc` (`libri_`, `iso_`, `halluc_`): speech, then about 2.5 s of
  digital silence over −60 dBFS room noise. Whisper adds "Thank you." or
  "you" over that tail, so the trim must still cut it down to the kept
  tail. `speech_end_sample` is where the speech ends in the clip.
