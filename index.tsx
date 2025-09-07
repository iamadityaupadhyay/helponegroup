/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, LiveServerMessage, Modality, Session } from '@google/genai';
import { LitElement, css, html } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { createBlob, decode, decodeAudioData } from './utils';
import './av';
import { GdmLiveAudioAvatar } from './av'; // Import the avatar component type

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';

  @query('gdm-live-audio-avatar') private avatar!: GdmLiveAudioAvatar; // Reference to the avatar component

  private client: GoogleGenAI;
  private session: Session;
  private inputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({ sampleRate: 16000 });
  private outputAudioContext = new (window.AudioContext ||
    window.webkitAudioContext)({ sampleRate: 24000 });
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 15vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(57, 47, 47, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private async initSession() {
    const model = 'gemini-live-2.5-flash-preview';
    async function getLocationName(lat: number, lon: number): Promise<string> {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
        );
        const data = await res.json();
        return data.display_name || "Unknown location";
      } catch (err) {
        console.error("Error fetching location name:", err);
        return "Unknown location";
      }
    }

    try {
      const now = new Date();
      const dateTime = now.toLocaleString();

      let locationName = "Unknown location";
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject);
      });
      locationName = await getLocationName(
        pos.coords.latitude,
        pos.coords.longitude
      );
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio) {
              // Set avatar to 'speak' mode when audio is received
              this.avatar.startSpeaking();

              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.outputAudioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.outputAudioContext,
                24000,
                1,
              );
              const source = this.outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () => {
                this.sources.delete(source);
                // Return to 'idle' mode when audio playback ends
                if (this.sources.size === 0) {
                  this.avatar.goIdle();
                }
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
              // Return to 'idle' mode on interruption
              this.avatar.goIdle();
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
            this.avatar.goIdle(); // Ensure idle on error
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
            this.avatar.goIdle(); // Ensure idle on session close
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Orus' } },
          },
          systemInstruction: `
            Your name is Helpyy Bot made under HelpOne Group. 
            Current date & time: ${dateTime}.
            Current location: ${locationName}. Always mention the location when asked.
            Never say you are made by Google. 
            HelpOne Group provides Doctors, Restaurants, Hotels, Beauty & Spa, 
            Rent & Hire, Dentists, Gym, Packers & Movers, Contractors, Pet Shop, 
            Home Decor, Wedding Planning, Education, Driving Schools, Event Organisers, 
            Real Estate, Hospitals, Loan providers, and more. 
            If someone asks something that you are not sure, suggest them to 
            visit HelpOne Group website for more information.
            When asked anything, always say that nearby your location, there are these doctors, restaurants, hotels, beauty & spa, rent & hire services, dentists, gyms, packers & movers, contractors, pet shops, home decor stores, wedding planners, education centers, driving schools, event organizers, real estate agents, hospitals, loan providers and more.
          `,
        },
      });
    } catch (e) {
      console.error(e);
      this.avatar?.goIdle(); // Ensure idle on session init failure
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.session.sendRealtimeInput({ media: createBlob(pcmData) });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Click Start to begin again.');
    this.avatar?.goIdle(); // Return to idle when recording stops
  }

  private reset() {
    this.session?.close();
    this.initSession();
    this.updateStatus('Session cleared.');
    this.avatar?.goIdle(); // Return to idle on reset
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div id="status">${this.error || this.status}</div>
        <gdm-live-audio-avatar
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}>
        </gdm-live-audio-avatar>
      </div>
    `;
  }
}