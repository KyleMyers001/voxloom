use super::super::process::tests::{fixture, NORMAL};
use super::*;
use std::{
    fs,
    time::{Duration, Instant},
};

#[test]
fn completed_recordings_do_not_exhaust_lifetime_admission() {
    let rt = ParakeetRuntime::new("/nonexistent-admission-test-worker".into());
    let epoch = rt.epoch();
    for number in 0..4100 {
        let id = format!("completed-{number}");
        rt.prepare(epoch, &id, "model", "v3", || {
            Err(SttErrorDto::new("model-missing", "Test resolver"))
        })
        .unwrap_or_else(|error| panic!("fresh recording {number}: {}", error.code));
        let out = rt
            .transcribe(
                epoch,
                &id,
                "model",
                vec![0.0; 160],
                16000,
                &SpeechFilterConfig::default(),
            )
            .unwrap();
        assert!(out.text.is_empty());
        assert_eq!(out.dropped, Some(DropReason::SilentAudio));
        // The UI finally releases even a successful silent recording.
        rt.cancel(epoch, &id).unwrap();
        wait(|| rt.idle());
    }
    rt.retire_main("settings");
    assert_eq!(rt.epoch(), epoch);
    prepare(&rt, "fresh-after-settings").unwrap();
    rt.cancel(epoch, "fresh-after-settings").unwrap();
    wait(|| rt.idle());
}

fn wait(test: impl Fn() -> bool) {
    let end = Instant::now() + Duration::from_secs(4);
    while !test() {
        assert!(Instant::now() < end, "condition deadline");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn prepare(rt: &ParakeetRuntime, id: &str) -> Result<(), SttErrorDto> {
    rt.prepare(rt.epoch(), id, "model", "v3", || {
        Ok(PathBuf::from("/model"))
    })
}
#[test]
fn admission_is_fast_loading_starts_before_pcm_and_transcribe_joins_same_worker() {
    let path = fixture(&format!(
        "open(__file__+'.started','a').write('x')\n{NORMAL}"
    ));
    let rt = ParakeetRuntime::new(path.clone());
    let start = Instant::now();
    prepare(&rt, "r").unwrap();
    assert!(start.elapsed() < Duration::from_millis(100));
    wait(|| path.with_extension("started").exists());
    std::thread::sleep(Duration::from_millis(25));
    let out = rt
        .transcribe(
            rt.epoch(),
            "r",
            "model",
            vec![0.25; 16000],
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap();
    assert_eq!(out.text, "[Music] Thank you.");
    assert_eq!(
        fs::read_to_string(path.with_extension("started")).unwrap(),
        "x"
    );
    wait(|| rt.idle());
}
#[test]
fn one_active_one_pending_fifo_busy_and_pending_cancel_never_kills_active() {
    let path = fixture(&format!(
        "open(__file__+'.started','a').write('x')\n{NORMAL}"
    ));
    let rt = ParakeetRuntime::new(path.clone());
    prepare(&rt, "a").unwrap();
    wait(|| path.with_extension("started").exists());
    prepare(&rt, "b").unwrap();
    assert_eq!(prepare(&rt, "c").unwrap_err().code, "busy");
    rt.cancel(rt.epoch(), "b").unwrap();
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "a",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap()
        .text,
        "[Music] Thank you."
    );
    wait(|| rt.idle());
    assert_eq!(
        fs::read_to_string(path.with_extension("started")).unwrap(),
        "x"
    );
}
#[test]
fn abandoned_preparation_has_a_finite_audio_wait_and_reaps_before_next_recording() {
    let path = fixture(&format!(
        "open(__file__+'.pid','w').write(str(os.getpid()))\n{NORMAL}"
    ));
    let rt = ParakeetRuntime::with_short_audio_wait(path.clone());
    prepare(&rt, "abandoned").unwrap();
    wait(|| path.with_extension("pid").exists());
    let pid = fs::read_to_string(path.with_extension("pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    wait(|| rt.idle());
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "abandoned",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap_err()
        .code,
        "timeout"
    );
}
#[test]
fn fifo_success_does_not_cancel_superseded_recording() {
    let path=fixture(&format!("load=read()\nopen(__file__+'.order','a').write(load['requestId'])\nr=load['requestId']\nsend(dict(protocolVersion=1,op='ready',requestId=r))\nh=read();readn(h['sampleCount']*4)\nsend(dict(protocolVersion=1,op='result',requestId=r,text=r,rawText=r,language=None,dropped=None))"));
    let rt = ParakeetRuntime::new(path.clone());
    prepare(&rt, "a").unwrap();
    prepare(&rt, "b").unwrap();
    let other = rt.clone();
    let second = std::thread::spawn(move || {
        other
            .transcribe(
                other.epoch(),
                "b",
                "model",
                vec![0.25],
                16000,
                &SpeechFilterConfig::default(),
            )
            .unwrap()
    });
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "a",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap()
        .text,
        "a"
    );
    assert_eq!(second.join().unwrap().text, "b");
    wait(|| rt.idle());
    assert_eq!(
        fs::read_to_string(path.with_extension("order")).unwrap(),
        "ab"
    );
}
#[test]
fn retirement_kills_and_reaps_old_helper_before_successor_starts() {
    let path=fixture("load=read()\nr=load['requestId']\nopen(__file__+'.'+r,'w').write(str(os.getpid()))\nif r=='old': time.sleep(60)\nsend(dict(protocolVersion=1,op='ready',requestId=r))\nh=read();readn(h['sampleCount']*4)\nsend(dict(protocolVersion=1,op='result',requestId=r,text=r,rawText=r,language=None,dropped=None))");
    let rt = ParakeetRuntime::new(path.clone());
    let old = rt.epoch();
    prepare(&rt, "old").unwrap();
    wait(|| path.with_extension("old").exists());
    let pid = fs::read_to_string(path.with_extension("old"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    rt.retire_main("main");
    prepare(&rt, "new").unwrap();
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "new",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap()
        .text,
        "new"
    );
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(rt.cancel(old, "new").is_err());
}
#[test]
fn blocked_model_resolution_never_holds_registry_lock_and_cancellation_prevents_launch() {
    let path = fixture(&format!(
        "open(__file__+'.started','w').write('x')\n{NORMAL}"
    ));
    let rt = ParakeetRuntime::new(path.clone());
    let (entered, rx) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    rt.prepare(rt.epoch(), "r", "model", "v3", move || {
        entered.send(()).unwrap();
        gate.recv().unwrap();
        Ok("/model".into())
    })
    .unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let start = Instant::now();
    rt.cancel(rt.epoch(), "r").unwrap();
    assert!(start.elapsed() < Duration::from_millis(100));
    release.send(()).unwrap();
    wait(|| rt.idle());
    assert!(!path.with_extension("started").exists());
}
#[test]
fn silence_uses_only_shared_gate_and_invalid_pcm_releases_worker() {
    let path = fixture(NORMAL);
    let rt = ParakeetRuntime::new(path);
    prepare(&rt, "silent").unwrap();
    let out = rt
        .transcribe(
            rt.epoch(),
            "silent",
            "model",
            vec![0.0; 16000],
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap();
    assert_eq!(out.dropped, Some(DropReason::SilentAudio));
    wait(|| rt.idle());
    prepare(&rt, "invalid").unwrap();
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "invalid",
            "model",
            vec![f32::NAN],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap_err()
        .code,
        "unsupported-audio"
    );
    wait(|| rt.idle());
}
#[test]
fn cancelled_old_request_cleanup_cannot_kill_running_successor() {
    let path = fixture(NORMAL);
    let rt = ParakeetRuntime::new(path);
    prepare(&rt, "a").unwrap();
    rt.cancel(rt.epoch(), "a").unwrap();
    prepare(&rt, "b").unwrap();
    wait(|| {
        let reg = rt.inner.registry.lock().unwrap();
        reg.active.as_ref().is_some_and(|j| j.id == "b")
    });
    rt.cancel(rt.epoch(), "a").unwrap();
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "b",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap()
        .text,
        "[Music] Thank you."
    );
}
#[test]
fn parakeet_keeps_quiet_tail_and_raw_text_without_whisper_postfilters() {
    let path=fixture("load=read();r=load['requestId'];send(dict(protocolVersion=1,op='ready',requestId=r))\nh=read();a=readn(h['sampleCount']*4)\nassert h['sampleCount']==48000\nassert a[-128:]==bytes(128)\nsend(dict(protocolVersion=1,op='result',requestId=r,text='[Music] Thank you.',rawText='[Music] Thank you.',language=None,dropped=None))");
    let rt = ParakeetRuntime::new(path);
    prepare(&rt, "tail").unwrap();
    let pcm = [vec![0.25; 16000], vec![0.0; 32000]].concat();
    let out = rt
        .transcribe(
            rt.epoch(),
            "tail",
            "model",
            pcm,
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap();
    assert_eq!(out.text, "[Music] Thank you.");
    assert_eq!(out.raw_text, out.text);
    assert_eq!(out.dropped, None);
}

#[test]
fn cancel_before_prepare_is_sticky_and_old_epoch_cannot_touch_successor() {
    let path = fixture(NORMAL);
    let rt = ParakeetRuntime::new(path);
    let old = rt.epoch();
    rt.cancel(old, "r").unwrap();
    assert_eq!(prepare(&rt, "r").unwrap_err().code, "cancelled");
    rt.retire_main("settings");
    assert_eq!(rt.epoch(), old);
    rt.retire_main("main");
    assert_ne!(rt.epoch(), old);
    prepare(&rt, "r").unwrap();
    assert_eq!(rt.cancel(old, "r").unwrap_err().code, "cancelled");
    assert_eq!(
        rt.transcribe(
            rt.epoch(),
            "r",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default()
        )
        .unwrap()
        .text,
        "[Music] Thank you."
    );
}

#[test]
fn terminal_replay_window_is_bounded_fifo_without_release_refresh() {
    let rt = ParakeetRuntime::new("/nonexistent-admission-test-worker".into());
    let epoch = rt.epoch();
    for number in 0..MAX_RECENT_IDS {
        assert!(!rt.cancel(epoch, &format!("unknown-{number}")).unwrap());
    }
    assert!(!rt.cancel(epoch, "unknown-0").unwrap());
    assert!(!rt.cancel(epoch, "overflow").unwrap());
    {
        let reg = rt.inner.registry.lock().unwrap();
        assert_eq!(reg.recent.len(), MAX_RECENT_IDS);
        assert_eq!(reg.terminal_order.len(), MAX_RECENT_IDS);
        assert!(!reg.recent.contains_key("unknown-0"));
        assert_eq!(reg.terminal_order.front().unwrap(), "unknown-1");
    }
    assert_eq!(prepare(&rt, "unknown-1").unwrap_err().code, "cancelled");
    rt.retire_main("settings");
    assert_eq!(prepare(&rt, "overflow").unwrap_err().code, "cancelled");
    // Reuse outside the finite window is deliberately permitted, not forever
    // single-use. Production generates a fresh random UUID per recording.
    prepare(&rt, "unknown-0").unwrap();
    rt.cancel(epoch, "unknown-0").unwrap();
    wait(|| rt.idle());
    rt.retire_main("main");
    {
        let reg = rt.inner.registry.lock().unwrap();
        assert!(reg.recent.is_empty());
        assert!(reg.terminal_order.is_empty());
    }
    assert_eq!(rt.cancel(epoch, "fresh").unwrap_err().code, "cancelled");
}

#[test]
fn successful_result_remains_single_use_until_terminal_replay_eviction() {
    let rt = ParakeetRuntime::new(fixture(NORMAL));
    let epoch = rt.epoch();
    prepare(&rt, "done").unwrap();
    rt.transcribe(
        epoch,
        "done",
        "model",
        vec![0.25],
        16000,
        &SpeechFilterConfig::default(),
    )
    .unwrap();
    wait(|| rt.idle());
    assert_eq!(prepare(&rt, "done").unwrap_err().code, "transcribe-failed");
    assert!(rt
        .transcribe(
            epoch,
            "done",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default(),
        )
        .is_err());
    assert!(!rt.cancel(epoch, "done").unwrap());
    assert!(!rt.cancel(epoch, "done").unwrap());
    assert_eq!(prepare(&rt, "done").unwrap_err().code, "cancelled");
    assert_eq!(rt.inner.registry.lock().unwrap().terminal_order.len(), 1);
    for number in 0..MAX_RECENT_IDS {
        rt.cancel(epoch, &format!("later-{number}")).unwrap();
    }
    prepare(&rt, "done").unwrap();
    rt.cancel(epoch, "done").unwrap();
    wait(|| rt.idle());
}

#[test]
fn active_and_pending_ownership_survive_terminal_replay_eviction() {
    let path = fixture(NORMAL);
    let rt = ParakeetRuntime::new(path);
    let epoch = rt.epoch();
    let (entered, rx) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    rt.prepare(epoch, "active", "model", "v3", move || {
        entered.send(()).unwrap();
        gate.recv().unwrap();
        Ok("/model".into())
    })
    .unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    prepare(&rt, "pending").unwrap();
    let (active, pending) = {
        let reg = rt.inner.registry.lock().unwrap();
        (reg.jobs["active"].clone(), reg.jobs["pending"].clone())
    };
    for number in 0..=MAX_RECENT_IDS {
        rt.cancel(epoch, &format!("before-{number}")).unwrap();
    }
    prepare(&rt, "active").unwrap();
    prepare(&rt, "pending").unwrap();
    assert_eq!(prepare(&rt, "third").unwrap_err().code, "busy");
    assert_eq!(
        rt.prepare(epoch, "pending", "other-model", "v3", || {
            panic!("duplicate must not resolve")
        })
        .unwrap_err()
        .code,
        "transcribe-failed"
    );
    {
        let reg = rt.inner.registry.lock().unwrap();
        assert!(Arc::ptr_eq(&reg.jobs["active"], &active));
        assert!(Arc::ptr_eq(&reg.jobs["pending"], &pending));
    }
    rt.cancel(epoch, "active").unwrap();
    for number in 0..=MAX_RECENT_IDS {
        rt.cancel(epoch, &format!("after-{number}")).unwrap();
    }
    {
        let reg = rt.inner.registry.lock().unwrap();
        assert_eq!(reg.recent.len(), MAX_RECENT_IDS);
        assert_eq!(reg.terminal_order.len(), MAX_RECENT_IDS);
        assert!(!reg.recent.contains_key("active"));
        assert!(Arc::ptr_eq(reg.active.as_ref().unwrap(), &active));
        assert!(Arc::ptr_eq(&reg.pending.as_ref().unwrap().job, &pending));
    }
    // Even after its tombstone is evicted, a cancelled runner owns its slot
    // until reap. It cannot be re-prepared or let a third recording in.
    assert_eq!(prepare(&rt, "active").unwrap_err().code, "cancelled");
    assert_eq!(prepare(&rt, "third").unwrap_err().code, "busy");
    assert!(!rt.cancel(epoch, "active").unwrap());
    release.send(()).unwrap();
    wait(|| {
        let reg = rt.inner.registry.lock().unwrap();
        reg.active
            .as_ref()
            .is_some_and(|j| Arc::ptr_eq(j, &pending))
    });
    // A delayed finalizer of the distinct old ID cannot cancel the successor.
    assert!(!rt.cancel(epoch, "active").unwrap());
    assert_eq!(
        rt.transcribe(
            epoch,
            "pending",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap()
        .text,
        "[Music] Thank you."
    );
    wait(|| rt.idle());
}

#[test]
fn unconsumed_results_keep_ownership_and_retained_job_bound() {
    let rt = ParakeetRuntime::new("/nonexistent-admission-test-worker".into());
    let epoch = rt.epoch();
    for number in 0..MAX_RETAINED {
        rt.prepare(
            epoch,
            &format!("unconsumed-{number}"),
            "model",
            "v3",
            || Err(SttErrorDto::new("model-missing", "Test resolver")),
        )
        .unwrap();
        wait(|| rt.idle());
    }
    for number in 0..=MAX_RECENT_IDS {
        rt.cancel(epoch, &format!("unknown-{number}")).unwrap();
    }
    prepare(&rt, "unconsumed-0").unwrap();
    assert_eq!(prepare(&rt, "overflow").unwrap_err().code, "busy");
    assert_eq!(rt.inner.registry.lock().unwrap().jobs.len(), MAX_RETAINED);
    assert_eq!(
        rt.transcribe(
            epoch,
            "unconsumed-0",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap_err()
        .code,
        "model-missing"
    );
    prepare(&rt, "fresh").unwrap();
    rt.cancel(epoch, "fresh").unwrap();
    rt.retire_main("main");
    wait(|| rt.idle());
}

#[test]
fn pending_transcription_is_claimed_only_once() {
    let rt = ParakeetRuntime::new("/nonexistent-admission-test-worker".into());
    let epoch = rt.epoch();
    let (entered, rx) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    rt.prepare(epoch, "active", "model", "v3", move || {
        entered.send(()).unwrap();
        gate.recv().unwrap();
        Err(SttErrorDto::new("model-missing", "Test resolver"))
    })
    .unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    prepare(&rt, "pending").unwrap();
    let pending = rt.inner.registry.lock().unwrap().jobs["pending"].clone();
    let other = rt.clone();
    let first = std::thread::spawn(move || {
        other.transcribe(
            epoch,
            "pending",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default(),
        )
    });
    wait(|| pending.data.lock().unwrap().claimed);
    assert_eq!(
        rt.transcribe(
            epoch,
            "pending",
            "model",
            vec![0.25],
            16000,
            &SpeechFilterConfig::default(),
        )
        .unwrap_err()
        .code,
        "transcribe-failed"
    );
    rt.cancel(epoch, "pending").unwrap();
    assert_eq!(first.join().unwrap().unwrap_err().code, "cancelled");
    rt.cancel(epoch, "active").unwrap();
    release.send(()).unwrap();
    wait(|| rt.idle());
}
/// The capture resampler is windowed-sinc without clamping, so loud in-range
/// input can overshoot full scale. Parakeet must still transcribe it, and the
/// worker (strict like Swift's Wire.samples) must only ever see [-1, 1].
#[test]
fn resampler_overshoot_on_loud_audio_is_clamped_and_transcribed() {
    let path = fixture("load=read()\nr=load['requestId']\nsend(dict(protocolVersion=1,op='ready',requestId=r))\nh=read()\nn=h['sampleCount']\ns=struct.unpack('<%df'%n,readn(n*4))\nassert all(-1.0<=x<=1.0 for x in s) and max(s)==1.0 and min(s)==-1.0\nsend(dict(protocolVersion=1,op='result',requestId=r,text='loud',rawText='loud',language=None,dropped=None))");
    let rt = ParakeetRuntime::new(path);
    for native_rate in [44_100u32, 48_000] {
        let period = native_rate as usize / 440;
        let square: Vec<f32> = (0..native_rate as usize)
            .map(|i| if (i % period) < period / 2 { 0.9 } else { -0.9 })
            .collect();
        let mut downmixer = crate::capture::resample::Downmixer::new(native_rate).unwrap();
        let mut pcm = downmixer.process(&square).unwrap();
        pcm.extend(downmixer.flush().unwrap());
        let peak = pcm.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            peak > 1.0,
            "{native_rate} Hz resampled peak {peak} does not overshoot"
        );
        let id = format!("loud-{native_rate}");
        prepare(&rt, &id).unwrap();
        let out = rt
            .transcribe(
                rt.epoch(),
                &id,
                "model",
                pcm,
                16000,
                &SpeechFilterConfig::default(),
            )
            .unwrap_or_else(|error| panic!("{native_rate} Hz: {}", error.code));
        assert_eq!(out.text, "loud");
        wait(|| rt.idle());
    }
}
