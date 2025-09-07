import {LitElement, css, html} from 'lit';
import {customElement, property, state} from 'lit/decorators.js';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {Analyser} from './analyser';

type AvatarMode = 'idle' | 'speak' | 'whisper' | 'dance';

@customElement('gdm-live-audio-avatar')
export class GdmLiveAudioAvatar extends LitElement {
  /* ---------------------- Audio IO ---------------------- */
  private _outputNode!: AudioNode;
  private _inputNode!: AudioNode;

  @property({attribute: false})
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    this.outputAnalyser = new Analyser(this._outputNode);
  }
  get outputNode() { return this._outputNode; }

  @property({attribute: false})
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    this.inputAnalyser = new Analyser(this._inputNode);
  }
  get inputNode() { return this._inputNode; }

  private inputAnalyser!: Analyser;   // mic (user)
  private outputAnalyser!: Analyser;  // TTS (assistant)

  /* ---------------------- Scene ---------------------- */
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private composer!: EffectComposer;
  private canvas!: HTMLCanvasElement;

  private avatar!: THREE.Group;
  private clock = new THREE.Clock();

  /* Cached references (optional; we’ll still traverse safely) */
  private headMesh?: THREE.Mesh;
  private teethMesh?: THREE.Mesh;

  /* ---------------------- State ---------------------- */
  @state() private _mode: AvatarMode = 'idle';
  @property({type: String}) set mode(m: AvatarMode) {
    console.log('Setting mode to:', m);
    this._mode = m;
  }
  get mode() { return this._mode; }

  // smoothed audio levels (EMA)
  private outLevel = 0;   // assistant
  private inLevel = 0;    // mic

  // blink state
  private nextBlinkAt = 0;
  private blinkT = 0;

  // dance state
  private dancePhase = 0;
  private isDancing = false;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
    }
  `;

  /* ---------------------- Lifecycle ---------------------- */
  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    this.initThree();
    this.loadAvatar('/avatar.glb'); 
    this.animate();
  }

  private initThree() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x151515);

    this.camera = new THREE.PerspectiveCamera(
      50,
      this.clientWidth / this.clientHeight || window.innerWidth / window.innerHeight,
      0.1, 100
    );
    this.camera.position.set(0, 1.55, 2.6);

    this.renderer = new THREE.WebGLRenderer({canvas: this.canvas, antialias: true, alpha: true});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.clientWidth || window.innerWidth, this.clientHeight || window.innerHeight);

    const renderPass = new RenderPass(this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(this.renderer.domElement.width, this.renderer.domElement.height), 0.6, 0.4, 0.85);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    this.composer.addPass(bloomPass);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 5, 2);
    key.castShadow = true;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.6);
    rim.position.set(-3, 4, -2);
    this.scene.add(rim);

    window.addEventListener('resize', () => this.onResize());
  }

  private loadAvatar(url: string) {
    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
      this.avatar = gltf.scene;
      this.avatar.position.set(0, 0, 0);
      this.avatar.traverse((c: any) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
          if (c.name === 'Wolf3D_Head') this.headMesh = c as THREE.Mesh;
          if (c.name === 'Wolf3D_Teeth') this.teethMesh = c as THREE.Mesh;
        }
      });

      // Debug: list morph targets so you see exactly what’s available
      this.avatar.traverse((c: any) => {
        if (c.isMesh && c.morphTargetDictionary) {
          console.log('[Morphs]', c.name, Object.keys(c.morphTargetDictionary));
        }
      });

      this.scene.add(this.avatar);
      this.scheduleNextBlink();
    });
  }

  /* ---------------------- Public controls ---------------------- */
  startSpeaking()  { this._mode = 'speak'; }
  startWhisper()   { this._mode = 'whisper'; }
  startDance()     { this._mode = 'dance'; this.isDancing = true; }
  stopDance()      { this.isDancing = false; if (this._mode === 'dance') this._mode = 'idle'; }
  goIdle()         { this._mode = 'idle'; this.isDancing = false; }

  /* ---------------------- Utils ---------------------- */
  private onResize() {
    const w = this.clientWidth || window.innerWidth;
    const h = this.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  /** Average FFT to 0..1 and smooth with EMA */
  private pullLevel(an: Analyser | undefined, prev: number, alpha = 0.35) {
    if (!an) return prev * 0.95;
    an.update();
    const data = an.data;
    if (!data || !data.length) return prev * 0.95;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const v = (sum / (data.length * 255));
    return prev * (1 - alpha) + v * alpha;
  }

  /** Apply to *all* meshes that contain the morph name */
  private applyMorph(name: string, value: number) {
    if (!this.avatar) return;
    this.avatar.traverse((child: any) => {
      if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
        const idx = child.morphTargetDictionary[name];
        if (idx !== undefined) {
          child.morphTargetInfluences[idx] = THREE.MathUtils.clamp(value, 0, 1);
        }
      }
    });
  }

  private lerpMorph(name: string, to: number, rate = 0.15) {
    if (!this.avatar) return;
    this.avatar.traverse((child: any) => {
      if (child.isMesh && child.morphTargetDictionary && child.morphTargetInfluences) {
        const idx = child.morphTargetDictionary[name];
        if (idx !== undefined) {
          const cur = child.morphTargetInfluences[idx] || 0;
          child.morphTargetInfluences[idx] = THREE.MathUtils.lerp(cur, THREE.MathUtils.clamp(to, 0, 1), rate);
        }
      }
    });
  }

  private scheduleNextBlink() {
    // random 2–6s
    this.nextBlinkAt = performance.now() + 2000 + Math.random() * 4000;
  }

  private doBlink(dt: number) {
    const now = performance.now();
    if (now >= this.nextBlinkAt && this.blinkT <= 0) {
      this.blinkT = 1.0; // start blink
      this.scheduleNextBlink();
    }
    if (this.blinkT > 0) {
      // simple triangular blink envelope ~120ms close/open
      this.blinkT -= dt * 6;
      const phase = 1 - Math.abs(1 - Math.max(this.blinkT, 0) * 2); // 0->1->0
      // Try common names; if not present, it’s harmless
      this.applyMorph('eyeBlinkLeft', phase);
      this.applyMorph('eyeBlinkRight', phase);
      // Some rigs put blink on EyeLeft/EyeRight with different naming; fallback:
      this.applyMorph('eyesClosed', phase);
    }
  }

  /* ---------------------- Per-mode animation ---------------------- */
  private animate() {
    requestAnimationFrame(() => this.animate());

    const dt = this.clock.getDelta();

    this.outLevel = this.pullLevel(this.outputAnalyser, this.outLevel, 0.35);
    this.inLevel = this.pullLevel(this.inputAnalyser, this.inLevel, 0.35);
    
    if (this.avatar) {
      const t = performance.now() * 0.0015;
      const head = this.headMesh as any;
      if (head) {
        head.rotation.y = Math.sin(t * 0.6) * 0.03;
        head.rotation.x = Math.sin(t * 0.4) * 0.02;
        // Add slight head tilt for listening based on inLevel
        head.rotation.z = THREE.MathUtils.lerp(
          head.rotation.z,
          this.inLevel * 0.1, // Tilt up to 0.1 radians when user is speaking
          0.1
        );
      }
    }

    // Reset baseline each frame (morphs that we control)
    this.lerpMorph('mouthSmile', 0, 0.12);

    // Enhanced ear animations for listening
    if (this.avatar) {
      const earScale = 1 + this.inLevel * 0.3; // Increased scale intensity
      const wiggle = Math.sin(performance.now() * 0.006) * this.inLevel * 0.25; // Increased wiggle
      const L = this.avatar.getObjectByName('LeftEar') as THREE.Object3D;
      const R = this.avatar.getObjectByName('RightEar') as THREE.Object3D;
      if (L) {
        L.scale.set(1, earScale + wiggle, 1);
        L.rotation.z = this.inLevel * 0.1; // Subtle ear rotation
      }
      if (R) {
        R.scale.set(1, earScale - wiggle, 1);
        R.rotation.z = -this.inLevel * 0.1; // Opposite rotation for right ear
      }
    }

    // Mode logic
    console.log(this._mode);
    switch (this._mode) {
      case 'speak': {
        // Drive mouth by TTS/output level; add consistent smile
        const mouth = THREE.MathUtils.clamp(this.outLevel * 3.0, 0, 1);
        this.applyMorph('mouthOpen', mouth);
        this.lerpMorph('mouthSmile', mouth); // Increased smile
        break;
      }
      case 'whisper': {
        // Subtle mouth + head lean-in; add slight smile
        const mouth = THREE.MathUtils.clamp(this.outLevel * 1.2, 0, 0.4);
        this.applyMorph('mouthOpen', mouth);
        this.lerpMorph('mouthSmile', 0.15, 0.08); // Increased smile
        if (this.avatar) {
          const lean = 0.04 + this.outLevel * 0.05;
          this.avatar.position.y = THREE.MathUtils.lerp(this.avatar.position.y, lean, 0.08);
          this.avatar.rotation.x = THREE.MathUtils.lerp(this.avatar.rotation.x, -0.03, 0.08);
        }
        break;
      }
      case 'dance': {
        this.isDancing = true;
        const t = performance.now() * 0.001;
        this.dancePhase += dt;
        // Groove: sway + bounce
        if (this.avatar) {
          this.avatar.position.y = Math.sin(t * 4) * 0.05 + 0.02;
          this.avatar.rotation.y = Math.sin(t * 2) * 0.25;
          this.avatar.rotation.z = Math.sin(t * 3.2) * 0.07;
        }
        // Keep mouth reactive to output so it can "sing"
        const mouth = THREE.MathUtils.clamp(this.outLevel * 2.5, 0, 1);
        this.applyMorph('mouthOpen', mouth);
        this.lerpMorph('mouthSmile', 0.25 + this.outLevel * 0.3, 0.15);
        break;
      }
      case 'idle':
      default: {
        // Breathing mouth movement
        const t = performance.now() * 0.001;
        const idleMouth = (Math.sin(t * 0.9) + 1) * 0.05; 
        this.lerpMorph('mouthOpen', idleMouth, 0.1);

        if (this.avatar) {
          // Gentle breathing & swaying
          this.avatar.position.y = Math.sin(t * 1.2) * 0.015;
          this.avatar.rotation.y = Math.sin(t * 0.6) * 0.05;
          this.avatar.rotation.x = Math.sin(t * 0.4) * 0.03;
        }
        break;
      }
    }

    // Teeth should follow mouthOpen (some rigs need it)
    if (this.teethMesh && this.headMesh) {
      const idx = this.headMesh.morphTargetDictionary?.['mouthOpen'];
      if (idx !== undefined) {
        const v = this.headMesh.morphTargetInfluences![idx] || 0;
        this.teethMesh.morphTargetInfluences![idx] = v;
      }
    }

    // Random blinks
    this.doBlink(dt);

    this.composer.render();
  }

  /* ---------------------- Render ---------------------- */
  protected render() { return html`<canvas></canvas>`; }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-avatar': GdmLiveAudioAvatar;
  }
}