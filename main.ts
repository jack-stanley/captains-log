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

const MODELS: string[] = [
	'gemini-2.5-pro-preview-03-25',
	'gemini-2.0-flash',
	'gemini-2.0-flash-lite',
	'gemini-1.5-flash',
	'gemini-1.5-pro'
];

interface AudioPluginSettings {
	model: string;
	apiKey: string;
	prompt: string;
	defaultNoteFolder: string;
	recordingFilePath: string;
	keepAudio: boolean;
	includeAudioFileLink: boolean;
	insertTranscriptLocation: "inline" | "newNote";
	templateFilePath: string;
}

let DEFAULT_SETTINGS: AudioPluginSettings = {
	model: 'gemini-2.0-flash-lite', // Default Google model
	apiKey: '',
	prompt:
		'You will be provided an audio file. Your task is to compose a concise memo from this audio file in markdown (Obsidian). If you are provided a template, follow this template as precisely as possible. Otherwise, structure the memo in a way that makes sense. Do not be conversational, simply return the memo text. Write the text in the first person perspective.\n',
	defaultNoteFolder: '',
	recordingFilePath: "Captain's Log/recordings",
	keepAudio: true,
	includeAudioFileLink: false,
	insertTranscriptLocation: "newNote",
	templateFilePath: '',
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
			callback: async () => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					// If there’s an active note, use its editor.
					this.commandGenerateTranscript(activeView.editor);
				} else {
					// No active markdown view – notify and set insertion to new note.
					new Notice("No active file open. The transcript will be generated in a new note.");
					// Optionally, you can open a modal here to let the user select an audio file.
					// Or, if you already have the audio file reference by other means, call transcribeRecording directly.
				}
			},
		});

		// Command for recording a new captain's log.
		this.addCommand({
			id: 'record-captains-log',
			name: "Record Captain's Log",
			callback: async () => {
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
		this.addRibbonIcon("book-audio", "Record Captain's Log", async (evt: MouseEvent) => {
			const audioFileBlob = await new AudioRecordModal(
				this.app,
				this.handleAudioRecording.bind(this),
				this.settings
			).open();
		});

		this.addSettingTab(new CaptainsLogSettingTab(this.app, this));
	}

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
	
			// Get the recording folder from settings.
			const recordingFolder = this.settings.recordingFilePath.trim(); // e.g., "Captain's Log/recordings"

			// Get the current date and determine the period.
			const date = new Date();
			const formattedDate = date.toISOString().slice(0, 10); // "YYYY-MM-DD"
			const hours = date.getHours();
			const period = hours >= 4 && hours < 12 
				? 'Morning' 
				: hours >= 12 && hours < 20 
				? 'Afternoon' 
				: 'Night';

			// Start with count = 1 and generate the file name.
			let count = 1;
			let fileName = `recording-${formattedDate}-${period}.mp3`;

			// If a recording folder is specified, ensure the file name is unique in that folder.
			if (recordingFolder) {
				while (this.app.vault.getAbstractFileByPath(normalizePath(`${recordingFolder}/${fileName}`))) {
					count++;
					fileName = `recording-${formattedDate}-${period}-${count}.mp3`;
				}
			} else {
				// Otherwise, ensure uniqueness in the vault root.
				while (this.app.vault.getAbstractFileByPath(fileName)) {
					count++;
					fileName = `recording-${formattedDate}-${period}-${count}.mp3`;
				}
			}

			const file = await saveFile(this.app, audioFile, fileName, this.settings.recordingFilePath);
	
			this.settings.keepAudio = keepAudio;
			this.settings.includeAudioFileLink = includeAudioFileLink;
			await this.saveSettings();
	
			if (includeAudioFileLink && keepAudio && this.settings.insertTranscriptLocation !== "newNote") {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					const editor = activeView.editor;
					const cursor = editor.getCursor();
					const link = `![[${file.path}]]`;
					editor.replaceRange(link, cursor);
				} else {
					new Notice("No active editor found. Audio file link not inserted.");
				}
			}
			
			if (transcribe) {
				await this.transcribeRecording(file);
				if (!keepAudio) {
					await this.app.vault.delete(file);
					const folder = this.app.vault.getAbstractFileByPath(this.settings.recordingFilePath);
					if (folder instanceof TAbstractFile && folder.children.length === 0) {
						await this.app.vault.delete(folder);
					}
				}
			}
		} catch (error) {
			console.error('Error handling audio recording:', error);
			new Notice('Failed to handle audio recording');
		}
	}
	

	// Uploads the audio file to Google GenAI and generates a transcript/notes.
	async transcribeRecording(audioFile: TFile) {
		// Check for an active markdown view.
		let activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
	
		// If inline insertion is chosen but no active file is open, notify and switch to new note.
		if (this.settings.insertTranscriptLocation === "inline" && !activeView) {
			new Notice("No active file open. Defaulting to generating the transcript in a new note.");
			this.settings.insertTranscriptLocation = "newNote";
		}
	
		new Notice('Processing audio for transcription...');

		// Determine the mime type based on the file extension.
		const mimeType = this.getMimeType(audioFile);


		// Read the audio file as binary and create a Blob.
		const arrayBuffer = await this.app.vault.adapter.readBinary(audioFile.path);
		const blob = new Blob([arrayBuffer], { type: mimeType });

		// Replace Google GenAI file.upload and generateContent calls with REST API fetch calls.
		try {
			// Determine the file size and mime type.
			const numBytes = blob.size;
			// (mimeType is obtained using getMimeType as before.)
			const displayName = "AUDIO";

			// Step 1: Initiate resumable upload to get the upload URL.
			const initResponse = await fetch(
				`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${this.settings.apiKey}`,
				{
					method: "POST",
					headers: {
						"X-Goog-Upload-Protocol": "resumable",
						"X-Goog-Upload-Command": "start",
						"X-Goog-Upload-Header-Content-Length": numBytes.toString(),
						"X-Goog-Upload-Header-Content-Type": mimeType,
						"Content-Type": "application/json"
					},
					body: JSON.stringify({ file: { display_name: displayName } })
				}
			);
			const uploadUrl = initResponse.headers.get("x-goog-upload-url");
			if (!uploadUrl) {
				throw new Error("Failed to retrieve upload URL");
			}

			// Step 2: Upload the audio file bytes.
			const uploadResponse = await fetch(uploadUrl, {
				method: "POST",
				headers: {
					"Content-Length": numBytes.toString(),
					"X-Goog-Upload-Offset": "0",
					"X-Goog-Upload-Command": "upload, finalize"
				},
				body: blob
			});
			const uploadData = await uploadResponse.json();
			const fileUri = uploadData.file.uri;
			if (!fileUri) {
				throw new Error("File URI not returned from upload");
			}
			new Notice("Audio uploaded. Generating transcript...");

			// Load the template content (if any)
			const templateContent = await this.loadTemplateContent();

			// Combine the prompt and template (you may adjust how you combine them as needed)
			const combinedPrompt = this.settings.prompt + (templateContent ? ("\n\nTemplate:\n" + templateContent) : "");

			// Step 3: Call generateContent using the REST API.
			const generatePayload = {
				contents: [
					{
						parts: [
							{ text: combinedPrompt },
							{ file_data: { mime_type: mimeType, file_uri: fileUri } }
						]
					}
				]
			};

			const generateResponse = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${this.settings.model}:generateContent?key=${this.settings.apiKey}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(generatePayload)
				}
			);
			const generateData = await generateResponse.json();
			
			// Extract transcript from the new response structure
			if (
				generateData &&
				Array.isArray(generateData.candidates) &&
				generateData.candidates.length > 0 &&
				generateData.candidates[0].content &&
				Array.isArray(generateData.candidates[0].content.parts) &&
				generateData.candidates[0].content.parts.length > 0 &&
				generateData.candidates[0].content.parts[0].text
			) {
				this.transcript = generateData.candidates[0].content.parts[0].text;
				if (this.settings.insertTranscriptLocation === "inline") {
					// At this point, activeView is guaranteed to exist.
					const editor = activeView.editor;
					const LnToWrite = this.getNextNewLine(editor, editor.getCursor("to").line);
					editor.replaceRange(this.transcript, { line: LnToWrite, ch: 0 });
					new Notice("Transcript generated and inserted inline.");
				} else if (this.settings.insertTranscriptLocation === "newNote") {
					// Create a new note with the transcript.
					// Prepend the audio file link if the setting is enabled.
					let transcriptContent = "";
					if (this.settings.includeAudioFileLink) {
						// Use the audioFile parameter passed to transcribeRecording.
						transcriptContent += `![[${audioFile.path}]]\n\n`;
					}
					transcriptContent += this.transcript;
					
					// Generate a unique title and note path.
					const timestamp = new Date().toISOString().replace(/:/g, "-");
					const date = new Date();
					const formattedDate = date.toISOString().slice(0, 10);
					const hours = date.getHours();
					const ampm =
						hours >= 4 && hours < 12
							? 'Morning'
							: hours >= 12 && hours < 20
							? 'Afternoon'
							: 'Night';
					let noteTitle = `Captain's Log ${formattedDate}-${ampm}`;
					let finalTitle = noteTitle;
					let notePath: string;
				
					const defaultFolder = this.settings.defaultNoteFolder.trim();
					if (defaultFolder) {
						let folder = this.app.vault.getAbstractFileByPath(defaultFolder);
						if (!folder) {
							try {
								await this.app.vault.createFolder(defaultFolder);
							} catch (error) {
								console.error("Error creating default folder:", error);
								new Notice(`Failed to create folder: ${defaultFolder}. Using vault root instead.`);
							}
						}
						// Ensure a unique note title.
						let noteCount = 1;
						while (this.app.vault.getAbstractFileByPath(normalizePath(`${defaultFolder}/${finalTitle}.md`))) {
							noteCount++;
							finalTitle = `Captain's Log ${formattedDate}-${ampm}-${noteCount}`;
						}
						notePath = normalizePath(`${defaultFolder}/${finalTitle}.md`);
					} else {
						// Fallback: use active file's folder if exists, or vault root.
						const activeFile = this.app.workspace.getActiveFile();
						if (activeFile) {
							const folderPath = activeFile.parent.path;
							let noteCount = 1;
							while (this.app.vault.getAbstractFileByPath(`${folderPath}/${finalTitle}.md`)) {
								noteCount++;
								finalTitle = `Captain's Log ${formattedDate}-${ampm}-${noteCount}`;
							}
							notePath = normalizePath(`${folderPath}/${finalTitle}.md`);
						} else {
							let noteCount = 1;
							while (this.app.vault.getAbstractFileByPath(`${finalTitle}.md`)) {
								noteCount++;
								finalTitle = `Captain's Log ${formattedDate}-${ampm}-${noteCount}`;
							}
							notePath = `${finalTitle}.md`;
						}
					}
				
					try {
						const newFile = await this.app.vault.create(notePath, transcriptContent);
						new Notice(`Transcript generated in a new note: ${finalTitle}.md`);
						const newLeaf = this.app.workspace.getLeaf(true);
						await newLeaf.openFile(newFile);
					} catch (error) {
						console.error("Error creating new note:", error);
						new Notice("Failed to create new note for transcript.");
					}
				}
			} else {
				throw new Error("No text returned from AI model.");
			}
		} catch (error) {
			console.error("Transcription failed:", error);
			new Notice(error.message);
		}
	}

	async loadTemplateContent(): Promise<string> {
		if (this.settings.templateFilePath && this.settings.templateFilePath.trim().length > 0) {
			const templateFile = this.app.vault.getAbstractFileByPath(this.settings.templateFilePath);
			if (templateFile instanceof TFile) {
				return await this.app.vault.read(templateFile);
			} else {
				console.warn("Template file not found at " + this.settings.templateFilePath);
			}
		}
		return "";
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
			.setName('Google AI Studio API Key')
			.setDesc('Enter your Google AI Studio API Key; get it here: https://aistudio.google.com/apikey.')
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
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(
						MODELS.reduce((acc, model) => {
							acc[model] = model;
							return acc;
						}, {} as Record<string, string>)
					)
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
			.setName('Default Note Folder')
			.setDesc('Enter the folder path (relative to the vault root) to store new transcripts. If it does not exist, it will be created.')
			.addText(text =>
				text
					.setPlaceholder('e.g., Notes/Transcripts')
					.setValue(this.plugin.settings.defaultNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultNoteFolder = value.trim();
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

		new Setting(containerEl)
		.setName("Transcript Insertion Location")
		.setDesc("Choose whether to insert the transcript inline in the active file or in a new note.")
		.addDropdown(dropdown => {
			dropdown.addOption("inline", "Inline");
			dropdown.addOption("newNote", "New Note");
			dropdown.setValue(this.plugin.settings.insertTranscriptLocation);
			dropdown.onChange(async (value: "inline" | "newNote") => {
				this.plugin.settings.insertTranscriptLocation = value;
				await this.plugin.saveSettings();
			});
		});

		new Setting(containerEl)
			.setName('Template Note File Path')
			.setDesc('Enter the path to a template note file whose content should be passed with the AI prompt (add .md).')
			.addText(text =>
				text
					.setPlaceholder('e.g., FolderName/Template.md')
					.setValue(this.plugin.settings.templateFilePath)
					.onChange(async (value) => {
						this.plugin.settings.templateFilePath = value;
						await this.plugin.saveSettings();
					})
			);

	}
}
