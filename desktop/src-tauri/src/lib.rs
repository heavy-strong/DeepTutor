mod config;
mod runtime;

use runtime::{Runtime, RuntimeStatus};
use tauri::{Manager, RunEvent, State};

#[tauri::command]
fn runtime_status(runtime: State<'_, Runtime>) -> RuntimeStatus {
    runtime.status()
}

#[tauri::command]
fn retry_runtime(app: tauri::AppHandle, runtime: State<'_, Runtime>) {
    runtime.stop_owned();
    runtime.start(app);
}

pub fn run() {
    let runtime = Runtime::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(runtime.clone())
        .invoke_handler(tauri::generate_handler![runtime_status, retry_runtime])
        .setup(move |app| {
            runtime.start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DeepTutor desktop")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Closing the window is the desktop equivalent of Ctrl+C in the
                // `deeptutor start` terminal: both servers go down with it.
                app.state::<Runtime>().stop_owned();
            }
        });
}
