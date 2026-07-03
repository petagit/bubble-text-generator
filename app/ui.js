import { HDR_PRESETS, MATERIAL_PRESETS } from './rendering.mjs';
import { ASPECT_OPTIONS, RESOLUTION_OPTIONS, VIDEO_FORMATS } from './capture.mjs';

// Static markup only — every element is wired up by id in main.mjs.
// Layout is a CapCut-style editor: top bar (mode switch + export), preview
// stage center, properties panel right, keyframe timeline docked bottom.
export function AppMarkup() {
  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="brand-dot" aria-hidden="true" />Bubble Text</div>
        <div className="mode-toggle" role="group" aria-label="View mode">
          <input id="mode3d" type="checkbox" defaultChecked hidden />
          <button type="button" className="mode-opt" data-mode-set="2d">2D</button>
          <button type="button" className="mode-opt" data-mode-set="3d">3D</button>
        </div>
        <span className="hint topbar-status" id="status">Loading default font…</span>
        <div className="topbar-actions">
          <button id="dlSvg" type="button" className="secondary">Download SVG</button>
          <button id="dlPng" type="button">Export PNG</button>
        </div>
      </header>

      <main>
        <div id="stage">
          <svg className="preview" id="preview" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
            <defs id="svgDefs"></defs>
            <g id="viewGroup">
              <path id="mainPath" />
              <path id="outlinePath" fill="none" stroke="#fff" strokeLinejoin="round" strokeLinecap="round" />
              <path id="hiPath" />
            </g>
          </svg>
          <canvas id="three"></canvas>
          <canvas id="record2d" hidden width="1920" height="1920"></canvas>
          <button id="resetView2D" type="button" className="reset-view" aria-label="Reset 2D view">Reset view</button>
          <div className="spinner" id="spin"></div>
        </div>
        <div id="captureBar" className="capture-bar" aria-label="Capture controls">
          <div className="capture-pill">
            <button type="button" className="cap-tab" data-capture-mode="image">Image</button>
            <button type="button" className="cap-tab" data-capture-mode="video">Video</button>
            <span className="cap-divider" />
            {ASPECT_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" className="aspect-chip" data-aspect-id={opt.value}>{opt.label}</button>
            ))}
          </div>
          <button id="shutter" type="button" className="shutter" aria-label="Take photo">
            <span className="shutter-ring" />
            <span className="shutter-dot" />
          </button>
          <div id="cycleChips" className="cycle-pill" hidden>
            {[1, 2, 3].map((n) => (
              <button key={n} type="button" className="cycle-chip" data-cycle={n} title={`Repeat ${n}× (rotation cycles in 3D, keyframe loops in 2D)`}>
                <span aria-hidden="true">↻</span>{n}x
              </button>
            ))}
          </div>
        </div>
      </main>

      <aside>
        <details className="sec" open>
          <summary>Text &amp; source</summary>
          <div className="sec-body">
            <div>
              <label htmlFor="text">Text</label>
              <input id="text" type="text" defaultValue="POPCAM" autoComplete="off" />
            </div>
            <div>
              <label htmlFor="builtin">Built-in font</label>
              <select id="builtin" defaultValue="https://raw.githubusercontent.com/google/fonts/main/ofl/bagelfatone/BagelFatOne-Regular.ttf">
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bagelfatone/BagelFatOne-Regular.ttf">Bagel Fat One (very puffy)</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/apache/luckiestguy/LuckiestGuy-Regular.ttf">Luckiest Guy</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/sniglet/Sniglet-Regular.ttf">Sniglet</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bungee/Bungee-Regular.ttf">Bungee</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bowlbyonesc/BowlbyOneSC-Regular.ttf">Bowlby One SC</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/passionone/PassionOne-Black.ttf">Passion One Black</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/changaone/ChangaOne-Regular.ttf">Changa One</option>
                <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf">Orbitron</option>
              </select>
            </div>
            <div>
              <label htmlFor="font">Custom font (.ttf / .otf)</label>
              <input id="font" type="file" accept=".ttf,.otf,.woff" />
            </div>
            <div>
              <label htmlFor="svgFile">Or upload an SVG</label>
              <input id="svgFile" type="file" accept=".svg,image/svg+xml" />
              <div className="svg-row">
                <span id="svgFileName" className="hint" />
                <button id="svgClear" type="button" className="secondary svg-clear">Clear SVG</button>
              </div>
              <div className="hint">Replaces the text input. Filled shapes get inflated through the same 2D / 3D pipeline.</div>
            </div>
          </div>
        </details>

        <details className="sec" open>
          <summary>Bubble</summary>
          <div className="sec-body">
            <div>
              <div className="row"><label htmlFor="inflate">Inflate</label><button type="button" className="kf-diamond" data-kf-add="inflate" title="Add Inflate keyframe" aria-label="Add Inflate keyframe">◆</button><span className="val" id="inflateVal">14</span></div>
              <input id="inflate" type="range" min="0" max="60" defaultValue="14" />
            </div>
            <div>
              <div className="row"><label htmlFor="blur">Bubble blend</label><button type="button" className="kf-diamond" data-kf-add="blur" title="Add Bubble blend keyframe" aria-label="Add Bubble blend keyframe">◆</button><span className="val" id="blurVal">3</span></div>
              <input id="blur" type="range" min="0" max="20" defaultValue="3" />
              <div className="hint">Higher = letters merge into a softer single blob.</div>
            </div>
            <div>
              <div className="row"><label htmlFor="spacing">Letter spacing</label><button type="button" className="kf-diamond" data-kf-add="spacing" title="Add Letter spacing keyframe" aria-label="Add Letter spacing keyframe">◆</button><span className="val" id="spacingVal">-30</span></div>
              <input id="spacing" type="range" min="-100" max="100" defaultValue="-30" />
            </div>
            <label className="checkbox"><input id="merge" type="checkbox" defaultChecked /> Soft-blend touching letters</label>
          </div>
        </details>

        <details className="sec" open>
          <summary>3D balloon</summary>
          <div className="sec-body">
            <div>
              <div className="row"><label htmlFor="thickness">Thickness</label><span className="val" id="thicknessVal">0.55</span></div>
              <input id="thickness" type="range" min="0.1" max="1.5" step="0.05" defaultValue="0.55" />
            </div>
            <div>
              <div className="row"><label htmlFor="meshDensity">Mesh density</label><span className="val" id="meshDensityVal">14</span></div>
              <input id="meshDensity" type="range" min="6" max="28" step="1" defaultValue="14" />
            </div>
            <div>
              <div className="row"><label htmlFor="glossy">Gloss</label><span className="val" id="glossyVal">0.85</span></div>
              <input id="glossy" type="range" min="0" max="1" step="0.05" defaultValue="0.85" />
            </div>
            <label className="checkbox"><input id="autoRotate" type="checkbox" /> Auto rotate</label>
            <div>
              <div className="row"><label htmlFor="rotateSpeed">Rotation speed</label><span className="val" id="rotateSpeedVal">0.8</span></div>
              <input id="rotateSpeed" type="range" min="0.1" max="3" step="0.1" defaultValue="0.8" />
            </div>
            <div>
              <label>Material</label>
              <div className="material-grid">
                {MATERIAL_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="material-chip"
                    data-material-id={preset.id}
                    aria-pressed={preset.id === MATERIAL_PRESETS[0].id ? 'true' : 'false'}
                    title={preset.name}
                  >
                    <span className="material-swatch" style={{ background: preset.fill }} />
                    <span>{preset.name}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label>Environment (HDR)</label>
              <div className="hdr-grid">
                {HDR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="hdr-chip"
                    data-hdr-id={preset.id}
                    aria-pressed={preset.id === HDR_PRESETS[0].id ? 'true' : 'false'}
                    title={preset.hint || preset.name}
                  >
                    <span className="hdr-swatch" style={{ background: preset.swatch }} />
                    <span>{preset.name}</span>
                  </button>
                ))}
              </div>
              <label className="checkbox" style={{ marginTop: 8 }}>
                <input id="showEnv" type="checkbox" /> Show environment as background
              </label>
            </div>
          </div>
        </details>

        <details className="sec">
          <summary>2D style</summary>
          <div className="sec-body">
            <div className="row">
              <label htmlFor="fill">Fill color</label>
              <input id="fill" type="color" defaultValue="#ff2d55" />
            </div>
            <label className="checkbox"><input id="threeD" type="checkbox" defaultChecked /> 2D shading (highlight + shadow)</label>
            <label className="checkbox"><input id="outline" type="checkbox" /> White outline</label>
            <div>
              <div className="row"><label htmlFor="outlineW">Outline width</label><span className="val" id="outlineWVal">8</span></div>
              <input id="outlineW" type="range" min="0" max="30" defaultValue="8" />
            </div>
          </div>
        </details>

        <details className="sec">
          <summary>Quality</summary>
          <div className="sec-body">
            <div>
              <div className="row"><label htmlFor="quality">Resolution</label><span className="val" id="qualityVal">1.5</span></div>
              <input id="quality" type="range" min="0.5" max="3" step="0.1" defaultValue="1.5" />
            </div>
            <label className="checkbox"><input id="liveDrag" type="checkbox" defaultChecked /> Lower quality while dragging</label>
          </div>
        </details>
      </aside>

      <section id="kfPanel" className="kf-panel" aria-label="Animation keyframes">
        <div className="kf-panel-head">
          <button id="kfPlay" type="button" className="secondary kf-btn">▶ Preview</button>
          <button id="kfAdd" type="button" className="kf-btn">+ Keyframe</button>
          <div id="kfTrackChips" className="kf-track-chips" role="tablist" aria-label="Animated parameter" />
          <span className="hint" id="keyframeStats">No keyframes — record will capture a 2-second static clip.</span>
          <span className="kf-spacer" />
          <button id="kfDelete" type="button" className="secondary kf-btn" hidden>Delete keyframe</button>
          <button id="kfClear" type="button" className="secondary kf-btn">Clear track</button>
        </div>
        <svg id="kfTimeline" className="kf-timeline" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" />
      </section>

      <div id="recIndicator" className="rec-indicator" aria-live="polite">
        <span className="rec-dot" />
        <span id="recElapsed" className="rec-elapsed">0.0s</span>
        <button id="recStop" type="button" className="rec-stop">
          <span className="rec-stop-square" /> Stop
        </button>
      </div>

      <div id="imageModal" className="modal" role="dialog" aria-modal="true" aria-labelledby="imageModalTitle">
        <div className="modal-backdrop" data-modal-close />
        <div className="modal-card">
          <div className="modal-header">
            <div id="imageModalTitle" className="modal-title">Photo preview</div>
            <button type="button" className="modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div className="modal-image checker">
            <img id="imagePreview" alt="Captured 3D bubble text" />
          </div>
          <div className="modal-controls">
            <label className="modal-field">
              <span>Resolution</span>
              <select id="imageRes" defaultValue="1920">
                {RESOLUTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="modal-field checkbox">
              <input id="imageBg" type="checkbox" defaultChecked /> Include background
            </label>
          </div>
          <div className="modal-actions">
            <button id="imageDiscard" type="button" className="secondary">Discard</button>
            <button id="imageDownload" type="button">Download PNG</button>
          </div>
        </div>
      </div>

      <div id="videoModal" className="modal" role="dialog" aria-modal="true" aria-labelledby="videoModalTitle">
        <div className="modal-backdrop" data-modal-close />
        <div className="modal-card">
          <div className="modal-header">
            <div id="videoModalTitle" className="modal-title">Video preview</div>
            <button type="button" className="modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div className="modal-video">
            <video id="videoPreview" controls loop muted playsInline />
          </div>
          <div id="videoReadyBanner" className="modal-banner" role="status">
            ✓ Recording ready — pick a format below, then tap <strong>Download</strong> to save.
          </div>
          <div className="modal-controls">
            <label className="modal-field">
              <span>Resolution</span>
              <select id="videoRes" defaultValue="1920">
                {RESOLUTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="modal-field">
              <span>Quality</span>
              <select id="videoQuality" defaultValue="high">
                <option value="low">Low</option>
                <option value="mid">Mid</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="modal-field">
              <span>Format</span>
              <select id="videoFormat" defaultValue="mp4">
                {VIDEO_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="modal-actions">
            <button id="videoDiscard" type="button" className="secondary">Discard</button>
            <button id="videoDownload" type="button" className="progress-btn">
              <span id="videoDownloadProgress" className="progress-fill" />
              <span id="videoDownloadLabel" className="progress-label">Download</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
