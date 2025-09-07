import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

@customElement('avatar-3d')
export class Avatar3D extends LitElement {
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 40vh;
      background: #222;
      border-radius: 12px;
      overflow: hidden;
      position: relative;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    #stats {
      position: absolute;
      top: 0;
      left: 0;
    }
  `;

  @property({ type: String }) modelUrl = 'https://threejs.org/examples/models/gltf/RobotExpressive/RobotExpressive.glb';

  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
  private mixer?: THREE.AnimationMixer;
  private actions: { [key: string]: THREE.AnimationAction } = {};
  private activeAction?: THREE.AnimationAction;
  private previousAction?: THREE.AnimationAction;
  private clock?: THREE.Clock;
  private stats?: Stats;
  private gui?: GUI;
  private model?: THREE.Object3D;
  private face?: THREE.Mesh;
  private api = { state: 'Walking' };

  firstUpdated() {
    this.initThree();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // Clean up Three.js resources
    window.removeEventListener('resize', this.onWindowResize);
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
      this.renderer.dispose();
    }
    if (this.gui) {
      this.gui.destroy();
    }
  }

  async initThree() {
    // Dynamically import Three.js and required addons
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { default: Stats } = await import('three/addons/libs/stats.module.js');
    const { GUI } = await import('three/addons/libs/lil-gui.module.min.js');

    // Initialize renderer
    const canvas = this.renderRoot.querySelector('canvas')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    // Initialize scene
    this.scene = new THREE.Scene();
    this.scene.background = null; // Transparent background
    this.scene.fog = new THREE.Fog(0xe0e0e0, 20, 100);

    // Initialize camera
    this.camera = new THREE.PerspectiveCamera(45, canvas.clientWidth / canvas.clientHeight, 0.25, 100);
    this.camera.position.set(-5, 3, 10);
    this.camera.lookAt(0, 2, 0);

    // Initialize clock
    this.clock = new THREE.Clock();

    // Lights
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 3);
    hemiLight.position.set(0, 20, 0);
    this.scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 3);
    dirLight.position.set(0, 20, 10);
    this.scene.add(dirLight);

    // Ground
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshPhongMaterial({ color: 0xcbcbcb, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);

    const grid = new THREE.GridHelper(200, 40, 0x000000, 0x000000);
    grid.material.opacity = 0.2;
    grid.material.transparent = true;
    this.scene.add(grid);

    // Load model
    const loader = new GLTFLoader();
    loader.load(
      this.modelUrl,
      (gltf) => {
        this.model = gltf.scene;
        this.scene!.add(this.model);
        this.createGUI(gltf.animations, THREE, Stats);
        this.animate();
      },
      undefined,
      (error) => {
        console.error('Error loading 3D model:', error);
      }
    );

    // Stats
    this.stats = new Stats();
    this.renderRoot.appendChild(this.stats.dom);
    this.stats.dom.id = 'stats';

    // Resize handler
    window.addEventListener('resize', this.onWindowResize.bind(this));
  }

  createGUI(animations: THREE.AnimationClip[], THREE: typeof import('three'), Stats: typeof import('three/addons/libs/stats.module.js')) {
    import('three/addons/libs/lil-gui.module.min.js').then(({ GUI }) => {
      this.gui = new GUI({ container: this.renderRoot });
      this.mixer = new THREE.AnimationMixer(this.model!);

      const states = ['Idle', 'Walking', 'Running', 'Dance', 'Death', 'Sitting', 'Standing'];
      const emotes = ['Jump', 'Yes', 'No', 'Wave', 'Punch', 'ThumbsUp'];

      // Initialize actions
      for (const clip of animations) {
        const action = this.mixer.clipAction(clip);
        this.actions[clip.name] = action;

        if (emotes.includes(clip.name) || states.indexOf(clip.name) >= 4) {
          action.clampWhenFinished = true;
          action.loop = THREE.LoopOnce;
        }
      }

      // States folder
      const statesFolder = this.gui.addFolder('States');
      const clipCtrl = statesFolder.add(this.api, 'state', states);
      clipCtrl.onChange(() => {
        this.fadeToAction(this.api.state, 0.5);
      });
      statesFolder.open();

      // Emotes folder
      const emoteFolder = this.gui.addFolder('Emotes');
      const createEmoteCallback = (name: string) => {
        this.api[name] = () => {
          this.fadeToAction(name, 0.2);
          this.mixer!.addEventListener('finished', this.restoreState.bind(this));
        };
        emoteFolder.add(this.api, name);
      };
      emotes.forEach((emote) => createEmoteCallback(emote));
      emoteFolder.open();

      // Expressions
      this.face = this.model!.getObjectByName('Head_4') as THREE.Mesh;
      if (this.face && this.face.morphTargetDictionary) {
        const expressions = Object.keys(this.face.morphTargetDictionary);
        const expressionFolder = this.gui.addFolder('Expressions');
        expressions.forEach((expression, i) => {
          expressionFolder.add(this.face!.morphTargetInfluences!, i.toString(), 0, 1, 0.01).name(expression);
        });
        expressionFolder.open();
      }

      // Play initial action
      this.activeAction = this.actions['Walking'];
      this.activeAction.play();
    });
  }

  fadeToAction(name: string, duration: number) {
    this.previousAction = this.activeAction;
    this.activeAction = this.actions[name];

    if (this.previousAction !== this.activeAction) {
      this.previousAction!.fadeOut(duration);
    }

    this.activeAction!
      .reset()
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(1)
      .fadeIn(duration)
      .play();
  }

  restoreState() {
    this.mixer!.removeEventListener('finished', this.restoreState.bind(this));
    this.fadeToAction(this.api.state, 0.2);
  }

  onWindowResize() {
    if (this.camera && this.renderer) {
      const canvas = this.renderRoot.querySelector('canvas')!;
      this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    }
  }

  animate() {
    this.renderer!.setAnimationLoop(() => {
      const dt = this.clock!.getDelta();
      if (this.mixer) this.mixer.update(dt);
      this.renderer!.render(this.scene!, this.camera!);
      this.stats!.update();
    });
  }

  render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'avatar-3d': Avatar3D;
  }
}