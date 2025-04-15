# CAPTAIN'S LOG ⛵️ ✏️ 📜

- Latest version: v1.0
- Github: https://github.com/jack-stanley/captains-log

This Obsidian plugin is designed to help you keep daily memos (captain's logs), directly from voice input. 

## Instructions
1. Install the plugin from the Obsidian community plugins store.
2. Enable the plugin in your Obsidian settings.
3. Get a Google AI Studio API key from here: https://aistudio.google.com/apikey. You may need to create a new Google Cloud project. Don't worry, usage of these models within reasonable limits (such as this plugin) is totally free (for now). You should not be billed for usage of this plugin.
4. Paste the API key into the plugin settings.
5. Click the "Record Memo" button in the Obsidian ribbon to start recording your log. Recording will start immediately. 
6. You may pause the recording and resume at any time. The stop button (square) will only save the audio file.
7. Click the "Transcribe" button once you are finished with your recording to get a summary of the audio file.

## Features
- Choose the gemini model you wish to use. Some will have varying speeds and output quality. The default (gemini-2.0-flash-lite) is very fast and pretty accurate. A good mix of high accuracy with reasonable speed is gemini-2.0-flash.
- Provide a custom prompt to the model. These can be very general instructions. Note that the model output is not fully deterministic, so the output may vary slightly each time you record a note. Pass a template file if you want more control over the structure of the Captain's Log. This feature is very powerful! You can shape these Captain's Logs to be anything you want!
- Set a default note folder.
- Set a default path for the audio files (can also choose not to save the audio files).
- Choose to embed the audio file in the note.
- Choose to insert the note inline in an existing note or create a new note each time.
- Provide a template note to the model. This template can include things like headers, instructions, etc. A good idea may be to include a "Transcription" header at the bottom, if you want to keep a verbatim transcription of your audio file in addition to the formatted summary.

## Apple Shortcuts
You can launch this plugin directly from Apple Shortcuts on Mac or iOS! Follow these steps:
1. Install the "Advanced URI" plugin from the Obsidian community plugins store (https://github.com/Vinzent03/obsidian-advanced-uri).
2. Create a new shortcut in Apple Shortcuts, using the "Open URLs" action.
3. Paste the following URL into the action: "obsidian://advanced-uri?commandid=captains-log%253Arecord-captains-log"
Tada!

(You could probably use this URI in other ways, on other platforms, but I have not tested it. If you do, please let me know how it works!)

## Advisories
- The plugin is still new. Expect some bugs and missing features. Please report any issues you encounter on the GitHub repository, and add any feature requests you may have.
- This plugin has only been verified extensively on Mac and iOS.

## Acknowledgements
- This plugin borrows very very heavily from Evan Moscoso's plugin "Smart Memos": https://github.com/Mossy1022/Smart-Memos. As in, a lot of the code is lifted directly from his plugin. The main difference is that he worked in the OpenAI ecoysystem, and I'm using Google's stack. I would encourage people to check out his plugin, although it has not been updated in several months.

## TODO
- Allow custom note/audio file names and patterns.
- Provide context to the model of previous notes.
