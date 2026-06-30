use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat, WavSpec, WavWriter};
use tokio::sync::oneshot;

type SharedWavWriter = Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>;

pub enum AudioCmd {
    Start {
        path: PathBuf,
        device_name: Option<String>,
        reply: oneshot::Sender<Result<()>>,
    },
    Pause {
        reply: oneshot::Sender<Result<()>>,
    },
    Resume {
        reply: oneshot::Sender<Result<()>>,
    },
    Stop {
        reply: oneshot::Sender<Result<PathBuf>>,
    },
    Status {
        reply: oneshot::Sender<String>,
    },
    ListDevices {
        reply: oneshot::Sender<Vec<String>>,
    },
}

// AudioHandle is Send+Sync and lives in Tauri managed state.
// It owns one end of a channel to the audio thread, which is the only place
// cpal::Stream (not Send) ever lives.
pub struct AudioHandle {
    sender: Mutex<std::sync::mpsc::Sender<AudioCmd>>,
    level: Arc<AtomicU32>,
}

impl AudioHandle {
    pub async fn start(&self, path: PathBuf, device_name: Option<String>) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .send(AudioCmd::Start { path, device_name, reply: tx })
            .map_err(|_| anyhow!("Audio thread is not running"))?;
        rx.await.map_err(|_| anyhow!("Audio thread closed unexpectedly"))?
    }

    pub async fn pause(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .send(AudioCmd::Pause { reply: tx })
            .map_err(|_| anyhow!("Audio thread is not running"))?;
        rx.await.map_err(|_| anyhow!("Audio thread closed unexpectedly"))?
    }

    pub async fn resume(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .send(AudioCmd::Resume { reply: tx })
            .map_err(|_| anyhow!("Audio thread is not running"))?;
        rx.await.map_err(|_| anyhow!("Audio thread closed unexpectedly"))?
    }

    pub async fn stop(&self) -> Result<PathBuf> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .send(AudioCmd::Stop { reply: tx })
            .map_err(|_| anyhow!("Audio thread is not running"))?;
        rx.await.map_err(|_| anyhow!("Audio thread closed unexpectedly"))?
    }

    pub async fn status(&self) -> String {
        let (tx, rx) = oneshot::channel();
        if self
            .sender
            .lock()
            .unwrap()
            .send(AudioCmd::Status { reply: tx })
            .is_err()
        {
            return "error".to_string();
        }
        rx.await.unwrap_or_else(|_| "error".to_string())
    }

    pub async fn list_devices(&self) -> Vec<String> {
        let (tx, rx) = oneshot::channel();
        if self
            .sender
            .lock()
            .unwrap()
            .send(AudioCmd::ListDevices { reply: tx })
            .is_err()
        {
            return vec![];
        }
        rx.await.unwrap_or_default()
    }

    pub fn get_level(&self) -> f32 {
        f32::from_bits(self.level.load(Ordering::Relaxed))
    }
}

// Spawns the dedicated audio thread and returns a handle to it.
pub fn spawn_audio_thread() -> AudioHandle {
    let (tx, rx) = std::sync::mpsc::channel::<AudioCmd>();
    let level = Arc::new(AtomicU32::new(0u32));
    let level_thread = Arc::clone(&level);

    std::thread::Builder::new()
        .name("scribe-audio".to_string())
        .spawn(move || audio_loop(rx, level_thread))
        .expect("failed to spawn audio thread");

    AudioHandle {
        sender: Mutex::new(tx),
        level,
    }
}

// All state that touches cpal::Stream lives here, on the audio thread.
struct RecordingCtx {
    stream: Option<cpal::Stream>,
    writer: SharedWavWriter,
    paused: Arc<AtomicBool>,
    output_path: Option<PathBuf>,
    level: Arc<AtomicU32>,
}

impl RecordingCtx {
    fn new(level: Arc<AtomicU32>) -> Self {
        Self {
            stream: None,
            writer: Arc::new(Mutex::new(None)),
            paused: Arc::new(AtomicBool::new(false)),
            output_path: None,
            level,
        }
    }

    fn start(&mut self, path: PathBuf, device_name: Option<String>) -> Result<()> {
        if self.stream.is_some() {
            return Err(anyhow!("Already recording"));
        }

        let host = cpal::default_host();
        let device = if let Some(name) = &device_name {
            let mut found = None;
            if let Ok(mut devs) = host.input_devices() {
                found = devs.find(|d| d.name().ok().as_deref() == Some(name.as_str()));
            }
            found.ok_or_else(|| anyhow!("Audio device '{name}' not found. Check Settings."))?
        } else {
            host.default_input_device()
                .ok_or_else(|| anyhow!("No microphone found. Please connect a microphone and grant permission in System Settings → Privacy → Microphone."))?
        };

        let config = device
            .default_input_config()
            .map_err(|e| anyhow!("Could not read microphone config: {e}"))?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let spec = WavSpec {
            channels: config.channels(),
            sample_rate: config.sample_rate().0,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };

        let wav = WavWriter::create(&path, spec)
            .map_err(|e| anyhow!("Failed to create recording file: {e}"))?;

        let shared_writer: SharedWavWriter = Arc::new(Mutex::new(Some(wav)));
        let writer_cb = Arc::clone(&shared_writer);
        let paused_cb = Arc::clone(&self.paused);
        let level_cb = Arc::clone(&self.level);
        self.paused.store(false, Ordering::Relaxed);

        let err_fn = |e: cpal::StreamError| eprintln!("[scribe-audio] stream error: {e}");

        let stream = match config.sample_format() {
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _| {
                    // Level computation (always, even when paused)
                    if !data.is_empty() {
                        let sum_sq: f64 = data.iter().map(|&s| (s as f64 / i16::MAX as f64).powi(2)).sum();
                        let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                        level_cb.store(rms.to_bits(), Ordering::Relaxed);
                    }
                    if paused_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut g) = writer_cb.lock() {
                        if let Some(w) = g.as_mut() {
                            for &s in data {
                                let _ = w.write_sample(s);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )?,
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    // Level computation (always, even when paused)
                    if !data.is_empty() {
                        let sum_sq: f64 = data.iter().map(|&s| (s as f64).powi(2)).sum();
                        let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                        level_cb.store(rms.to_bits(), Ordering::Relaxed);
                    }
                    if paused_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut g) = writer_cb.lock() {
                        if let Some(w) = g.as_mut() {
                            for &s in data {
                                let _ = w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )?,
            cpal::SampleFormat::I32 => device.build_input_stream(
                &config.into(),
                move |data: &[i32], _| {
                    // Level computation (always, even when paused)
                    if !data.is_empty() {
                        let sum_sq: f64 = data.iter().map(|&s| (s as f64 / i32::MAX as f64).powi(2)).sum();
                        let rms = (sum_sq / data.len() as f64).sqrt() as f32;
                        level_cb.store(rms.to_bits(), Ordering::Relaxed);
                    }
                    if paused_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut g) = writer_cb.lock() {
                        if let Some(w) = g.as_mut() {
                            for &s in data {
                                let _ = w.write_sample((s >> 16) as i16);
                            }
                        }
                    }
                },
                err_fn,
                None,
            )?,
            fmt => {
                return Err(anyhow!(
                    "Unsupported audio sample format: {fmt:?}. Please report this."
                ))
            }
        };

        stream.play().map_err(|e| {
            anyhow!(
                "Failed to start recording — microphone permission may be denied. \
                 Check System Settings → Privacy & Security → Microphone. ({e})"
            )
        })?;

        self.stream = Some(stream);
        self.writer = shared_writer;
        self.output_path = Some(path);
        Ok(())
    }

    fn pause(&mut self) -> Result<()> {
        if self.stream.is_none() {
            return Err(anyhow!("Not recording"));
        }
        self.paused.store(true, Ordering::Relaxed);
        Ok(())
    }

    fn resume(&mut self) -> Result<()> {
        if self.stream.is_none() {
            return Err(anyhow!("Not recording"));
        }
        self.paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    fn stop(&mut self) -> Result<PathBuf> {
        let stream = self.stream.take().ok_or_else(|| anyhow!("Not recording"))?;
        drop(stream); // stops CoreAudio callbacks

        // Reset level when stopped
        self.level.store(0u32, Ordering::Relaxed);

        // Brief settle to let any in-flight callback finish writing
        std::thread::sleep(std::time::Duration::from_millis(150));

        if let Ok(mut guard) = self.writer.lock() {
            if let Some(w) = guard.take() {
                w.finalize().map_err(|e| anyhow!("Failed to finalize WAV: {e}"))?;
            }
        }

        self.paused.store(false, Ordering::Relaxed);
        self.output_path.take().ok_or_else(|| anyhow!("No output path set"))
    }

    fn status(&self) -> String {
        if self.stream.is_none() {
            "idle".to_string()
        } else if self.paused.load(Ordering::Relaxed) {
            "paused".to_string()
        } else {
            "recording".to_string()
        }
    }
}

fn audio_loop(rx: std::sync::mpsc::Receiver<AudioCmd>, level: Arc<AtomicU32>) {
    let mut ctx = RecordingCtx::new(level);
    while let Ok(cmd) = rx.recv() {
        match cmd {
            AudioCmd::Start { path, device_name, reply } => {
                let _ = reply.send(ctx.start(path, device_name));
            }
            AudioCmd::Pause { reply } => {
                let _ = reply.send(ctx.pause());
            }
            AudioCmd::Resume { reply } => {
                let _ = reply.send(ctx.resume());
            }
            AudioCmd::Stop { reply } => {
                let _ = reply.send(ctx.stop());
            }
            AudioCmd::Status { reply } => {
                let _ = reply.send(ctx.status());
            }
            AudioCmd::ListDevices { reply } => {
                let host = cpal::default_host();
                let names = host
                    .input_devices()
                    .map(|devs| devs.filter_map(|d| d.name().ok()).collect::<Vec<_>>())
                    .unwrap_or_default();
                let _ = reply.send(names);
            }
        }
    }
}
