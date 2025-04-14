import {
	App,
	Editor,
	MarkdownView,
	normalizePath,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	MarkdownPostProcessorContext,
} from 'obsidian';
import {
	GoogleGenAI,
	createUserContent,
	createPartFromUri,
} from '@google/genai';

import { AudioRecordModal } from './AudioRecordModal';
import { saveFile } from './Utils';

interface AudioPluginSettings {
	model: string;
	apiKey: string;
	prompt: string;
	includeTranscript: boolean;
	recordingFilePath: string;
	keepAudio: boolean;
	includeAudioFileLink: boolean;
}

let DEFAULT_SETTINGS: AudioPluginSettings = {
	model: 'gemini-2.0-flash', // Default Google model
	apiKey: '',
	prompt:
		'You are an expert note-making AI for obsidian who specializes in the Linking Your Thinking (LYK) strategy. The following is a transcription of a recording of someone talking aloud or a conversation. There may be a lot of random things said given the fluidity of conversation or thought process. Give me detailed notes in markdown language on what was said in the most easy-to-understand, detailed, and conceptual format. Include any helpful information that can conceptualize the notes further or enhance the ideas, and then summarize what was said. Do not mention "the speaker" anywhere in your response. The notes you write should be written as if I were writing them. Finally, ensure to end with code for a mermaid chart that shows an enlightening concept map combining both the transcription and the information you added to it. The following is the transcribed audio:\n\n',
	includeTranscript: true,
	recordingFilePath: '',
	keepAudio: true,
	includeAudioFileLink: false,
};

export default class CaptainsLogPlugin extends Plugin {
	settings: AudioPluginSettings;
	writing: boolean = false;
	transcript: string = '';

	ai: GoogleGenAI;

	async onload() {
		await this.loadSettings();
		// Initialize the Google GenAI instance with the API key.
		this.ai = new GoogleGenAI({ apiKey: this.settings.apiKey });

		// Command for transcribing an existing audio file.
		this.addCommand({
			id: 'open-transcript-modal',
			name: 'Transcribe Audio',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				this.commandGenerateTranscript(editor);
			},
		});

		// Command for recording a new captain's log.
		this.addCommand({
			id: 'record-captains-log',
			name: "Record Captains Log",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				// Open the audio recorder and store the recorded audio Blob.
				const audioFileBlob = await new AudioRecordModal(
					this.app,
					this.handleAudioRecording.bind(this),
					this.settings
				).open();
			},
		});

		// Post-process markdown to render audio file links as playable audio.
		this.registerMarkdownPostProcessor(
			(el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
				const audioLinks = el.querySelectorAll(
					'a.internal-link[data-href$=".mp3"], a.internal-link[data-href$=".wav"]'
				);
				audioLinks.forEach((link) => {
					const href = link.getAttribute('data-href');
					if (!href) {
						console.error("Failed to get the href attribute from the link element.");
						return;
					}

					const abstractFile = this.app.vault.getAbstractFileByPath(href);
					if (!(abstractFile instanceof TFile)) {
						console.error("The path does not point to a valid file in the vault.");
						return;
					}

					const audio = document.createElement('audio');
					audio.src = this.app.vault.getResourcePath(abstractFile);
					audio.controls = true;
					audio.addEventListener('loadedmetadata', () => {
						if (audio.parentNode) {
							const durationDisplay = document.createElement('span');
							durationDisplay.textContent = `Duration: ${audio.duration.toFixed(2)} seconds`;
							audio.parentNode.insertBefore(durationDisplay, audio.nextSibling);
						}
					});

					audio.load();
					link.replaceWith(audio);
				});
			}
		);

		// Add a ribbon icon for quick recording.
		this.addRibbonIcon('book-audio', "Record Captain's Log", async (evt: MouseEvent) => {
			const audioFileBlob = await new AudioRecordModal(
				this.app,
				this.handleAudioRecording.bind(this),
				this.settings
			).open();
		});

		this.addSettingTab(new CaptainsLogSettingTab(this.app, this));
	}

	// Called when an audio recording is complete.
	async handleAudioRecording(
		audioFile: Blob,
		transcribe: boolean,
		keepAudio: boolean,
		includeAudioFileLink: boolean
	) {
		try {
			if (!audioFile) {
				console.log('No audio was recorded.');
				return;
			}

			// Save the audio recording as a file.
			// Adjust the extension as needed (here using .mp3 for illustration).
			const fileName = `recording-${Date.now()}.mp3`;
			const file = await saveFile(this.app, audioFile, fileName, this.settings.recordingFilePath);

			this.settings.keepAudio = keepAudio;
			this.settings.includeAudioFileLink = includeAudioFileLink;
			await this.saveSettings();

			// Insert a link to the audio file in the current note.
			if (includeAudioFileLink && keepAudio) {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					const editor = activeView.editor;
					const cursor = editor.getCursor();
					const link = `![[${file.path}]]`;
					editor.replaceRange(link, cursor);
					// Trigger re-render by modifying the line.
					editor.replaceRange('', { line: cursor.line, ch: cursor.ch }, { line: cursor.line, ch: cursor.ch });
				}
			}
			
			// Trigger transcription if requested.
			if (transcribe) {
				await this.transcribeRecording(file);
			}
		} catch (error) {
			console.error('Error handling audio recording:', error);
			new Notice('Failed to handle audio recording');
		}
	}

	// Uploads the audio file to Google GenAI and generates a transcript/notes.
	async transcribeRecording(audioFile: TFile) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			console.error('No active Markdown view found.');
			return;
		}
		const editor = activeView.editor;
		new Notice('Processing audio for transcription...');

		// Determine the mime type based on the file extension.
		const mimeType = this.getMimeType(audioFile);


		try {
			// Read the audio file as binary and create a Blob.
			const arrayBuffer = await this.app.vault.adapter.readBinary(audioFile.path);
			const blob = new Blob([arrayBuffer], { type: mimeType });

			// Upload the audio Blob.
			const uploadedFile = await this.ai.files.upload({
				file: blob,
				config: { mimeType },
			});
			new Notice('Audio uploaded. Generating transcript...');

			// log the API key
			console.log('Google API Key:', this.settings.apiKey);

			// Build the prompt from your settings.
			const promptText = this.settings.prompt;

			// Generate content using Google GenAI.
			const contents = createUserContent([
				createPartFromUri(uploadedFile.uri!, uploadedFile.mimeType!),
				promptText,
			]);
			console.log("Generated user content:", JSON.stringify(contents, null, 2));

			const response = await this.ai.models.generateContent({
				model: this.settings.model,
				contents,
			});
			console.log("Generate content response:", response);

			if (response && response.text) {
				this.transcript = response.text;
				const LnToWrite = this.getNextNewLine(editor, editor.getCursor('to').line);
				editor.replaceRange('\n# Transcript\n' + this.transcript, { line: LnToWrite, ch: 0 });
				new Notice('Transcript generated.');
			} else {
				throw new Error('No text returned from AI model.');
			}

			if (!this.settings.keepAudio) {
				await this.app.vault.delete(audioFile);
			}
		} catch (error) {
			console.error('Transcription failed:', JSON.stringify(error, null, 2));
			new Notice(error.message);
		}
	}
	  

	// Helper to determine mime type from file extension.
	getMimeType(file: TFile): string {
		const ext = file.extension.toLowerCase();
		if (ext === 'mp3') return 'audio/mp3';
		if (ext === 'wav') return 'audio/wav';
		// Default fallback.
		return 'application/octet-stream';
	}

	writeText(editor: Editor, lnToWrite: number, text: string) {
		const newLine = this.getNextNewLine(editor, lnToWrite);
		editor.setLine(newLine, '\n' + text.trim() + '\n');
		return newLine;
	}

	getNextNewLine(editor: Editor, ln: number) {
		let newLine = ln;
		while (editor.getLine(newLine).trim().length > 0) {
			if (newLine === editor.lastLine())
				editor.setLine(newLine, editor.getLine(newLine) + '\n');
			newLine++;
		}
		return newLine;
	}

	// Command that locates an audio file link in the current note and triggers transcription.
	commandGenerateTranscript(editor: Editor) {
		const position = editor.getCursor();
		const text = editor.getRange({ line: 0, ch: 0 }, position);
		const regex = [
			/(?<=\[\[)(([^[\]])+)\.(mp3|wav)(?=]])/g,
			/(?<=\[(.*)]\()(([^[\]])+)\.(mp3|wav)(?=\))/g,
		];

		this.findFilePath(text, regex)
			.then((path) => {
				const fileType = path.split('.').pop();
				if (!fileType) {
					new Notice('No audio file found');
				} else {
					this.app.vault.adapter.exists(path).then((exists) => {
						if (!exists) throw new Error(path + ' does not exist');
						this.app.vault.adapter.readBinary(path).then(async () => {
							if (this.writing) {
								new Notice('Generator is already in progress.');
								return;
							}
							this.writing = true;
							new Notice('Generating transcript...');
							const tfile = this.app.vault.getAbstractFileByPath(path);
							if (tfile instanceof TFile) {
								await this.transcribeRecording(tfile);
							} else {
								throw new Error('File not found in vault.');
							}
							this.writing = false;
						});
					});
				}
			})
			.catch((error) => {
				console.warn(error.message);
				new Notice(error.message);
			});
	}

	// Searches for an audio file path in the given text using regex.
	async findFilePath(text: string, regex: RegExp[]) {
		let filename = '';
		let result: RegExpExecArray | null;
		for (const reg of regex) {
			while ((result = reg.exec(text)) !== null) {
				filename = normalizePath(decodeURI(result[0])).trim();
			}
		}
		if (filename === '') throw new Error('No file found in the text.');
		const fullPath = filename;
		const fileExists = this.app.vault.getAbstractFileByPath(fullPath) instanceof TAbstractFile;
		if (fileExists) return fullPath;
		const allFiles = this.app.vault.getFiles();
		const foundFile = allFiles.find((file) => file.name === filename.split('/').pop());
		if (foundFile) return foundFile.path;
		throw new Error('File not found');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
	
}

// A settings tab for configuration within Obsidian.
class CaptainsLogSettingTab extends PluginSettingTab {
	plugin: CaptainsLogPlugin;

	constructor(app: App, plugin: CaptainsLogPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Google API Key')
			.setDesc('Enter your Google GenAI API Key.')
			.addText((text) =>
				text
					.setPlaceholder('Enter API Key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Model')
			.setDesc('Choose the model to use (e.g., gemini-2.0-flash).')
			.addText((text) =>
				text
					.setPlaceholder('Model')
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Prompt')
			.setDesc('The prompt to use for generating notes.')
			.addTextArea((text) =>
				text
					.setPlaceholder('Prompt')
					.setValue(this.plugin.settings.prompt)
					.onChange(async (value) => {
						this.plugin.settings.prompt = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Include Transcript')
			.setDesc('Include the transcript below the generated notes.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeTranscript)
					.onChange(async (value) => {
						this.plugin.settings.includeTranscript = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Recording File Path')
			.setDesc('Path to save the recording file (optional).')
			.addText((text) =>
				text
					.setPlaceholder('Recording file path')
					.setValue(this.plugin.settings.recordingFilePath)
					.onChange(async (value) => {
						this.plugin.settings.recordingFilePath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Keep Audio File')
			.setDesc('Keep the audio file after processing?')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.keepAudio)
					.onChange(async (value) => {
						this.plugin.settings.keepAudio = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Include Audio File Link')
			.setDesc('Insert a link to the audio file in the note.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeAudioFileLink)
					.onChange(async (value) => {
						this.plugin.settings.includeAudioFileLink = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
