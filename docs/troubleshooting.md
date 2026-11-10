---
title: Troubleshooting
---

[← Guide home](index.md)

# Troubleshooting

Find the symptom, try the first fix, then the next.

## Screens and slides

| Problem | Fix |
| --- | --- |
| A slide does not appear on a screen | Is the screen **open** (red dot on its card)? Press **Open** on it, or **Open all screens**. |
| A screen opened on the wrong monitor | **Settings → Screens → Edit…** on the screen: choose the display. **Identify displays** shows each monitor's number. |
| The live screen covers the controls | You attached a screen to the display your operator window is on. Press **Esc** and close that screen, or attach it to another display. |
| Text is too small or too large | The ⚙ on the screen: **Font size**. Check on the real screen. |
| A picture or video behind the text is missing | In the ⚙ of that screen, is **Slide backgrounds** ticked? Check the song, slide and app-wide backgrounds ([media](media.md#backgrounds)). |
| Slides of a presentation look different from the original | Export a PDF from the program you made it in and import that ([media](media.md#presentations-and-pictures)). |
| A video will not play or is stuck converting | Wait for the status line under the run sheet. A very long or unusual file can take minutes. Import videos before the service. |

## Stream

| Problem | Fix |
| --- | --- |
| *Start streaming* is grey or says no key | **Settings → Stream**: choose *Stream to YouTube* and paste the key. |
| It says it is streaming, but YouTube shows nothing | Open the broadcast in YouTube Studio: *auto-start* must be on for the key's broadcast. Check the key is the current one. |
| Many dropped frames, low bitrate | Upload is too slow: lower bitrate/resolution, use a cable ([streaming](streaming.md#watching-the-health-of-the-stream)). |
| The stream has no sound | Is the mixer on and not muted? The Stream panel warns when it is off. Check the master fader and meter in the Mixer tab. |
| Words must come off the stream at once | The **camera icon** (camera only) in the Stream panel. |

## Sound

| Problem | Fix |
| --- | --- |
| The sound interface is not listed | Plug it in before starting, then reopen the Mixer tab. On a Mac allow **microphone** access in System Settings → Privacy & Security. |
| Only two channels show for a multichannel desk | The desk may present itself as stereo until its USB mode is set; check the desk's USB settings. On Windows a desk that only gives channels through its own ASIO driver cannot be read. |
| Linux: a card is "in use" | Another sound program (PipeWire, PulseAudio) holds the card. Give it to ALSA, or use the two-channel input. |
| The video's sound is heard twice | Mute the *Video L / R* strips if your room desk already sends the video sound back to the computer ([sound](sound.md#three-sounds)). |
| Feedback (howling) | The **Monitor** plays where a microphone hears it. Switch it off or move it to headphones. |
| Voice and picture out of step | Add a **sync delay** on the master (start at about 150 ms and adjust). |

## ATEM, NDI and lights

| Problem | Fix |
| --- | --- |
| No ATEM panel | The switcher has to answer: check the Ethernet cable, the address in **Settings → ATEM**, and that the computer is on the same network ([ATEM](atem.md)). |
| NDI screen says the library is missing | Install **NDI Tools** or **NDI Runtime** from ndi.video ([NDI](ndi.md)). |
| No DMX panel | **Settings → DMX → Use DMX** must be ticked. Other lighting problems: see the [DMX troubleshooting table](dmx.md#troubleshooting). |

## Where things are stored

The app keeps songs, services, screens, the mixer and settings in its data folder: `~/Library/Application Support/prestreamer` on a Mac, `%APPDATA%\prestreamer` on Windows and `~/.config/prestreamer` on Linux. Copy it to make a backup or to move to another computer.

## Reporting a problem

[Open an issue](https://github.com/AC-Dubnica/prestreamer/issues) with what you did, what you expected, what happened, and the version (it is in the installer's file name). A screenshot helps. **Never include a stream key.**
