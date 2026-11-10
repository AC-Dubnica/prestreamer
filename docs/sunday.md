---
title: Sunday checklist
---

[← Guide home](index.md)

# Sunday checklist

Copy this page, print it, and tick it off. Parts marked *(if you stream)*, *(if you have lights)* and so on can be skipped when you do not use that part.

## During the week

- [ ] Make or duplicate the service: [the service and the run sheet](service.md). Add every song, reading, video and presentation, in order.
- [ ] Check every song on screen once: spelling, line breaks, the picture behind it. See [songs](songs.md).
- [ ] Import videos and presentations a day ahead, so you are not waiting for a conversion on Sunday. See [media](media.md).
- [ ] Write the quick messages you will need (phones, car park, children's church): [announcements](announcements.md).

## An hour before

- [ ] Start the computer and plug in everything first: projector or monitors, the sound interface or mixer's USB cable, the camera, the DMX interface, the network cable of the ATEM.
- [ ] Start PreStreamer. Check the **Present** tab shows today's service.
- [ ] **Open all screens** (top bar). Walk to the room: is the picture on the right screens, in the right size, the right way up?
- [ ] Click a few slides, including the first one of each song. Does the background show, is the text readable from the back of the room?
- [ ] **Video**: play the first seconds of every video. Is the picture there, and does the sound come from the room speakers? ([Sound](sound.md): the Audience panel.)
- [ ] **Stage monitor** (if you use one): does it show the current and next slide and the clock? ([Screens](screens.md))
- [ ] *(Sound)* Open the **Mixer** tab. Do the meters move when someone speaks into each microphone? Is the master meter well below the top? Put on headphones and switch on the **Monitor** to hear what the stream carries. ([Sound](sound.md))
- [ ] *(Cameras)* The ATEM panel shows its model and the inputs. Cut to each camera and see it on the stream screen. ([ATEM](atem.md))
- [ ] *(Lights)* In **Settings → DMX** check the interface is found, then recall each scene once. ([DMX](dmx.md))

## Before going live *(if you stream)*

- [ ] **Settings → Stream** says *Stream to YouTube*, the right screen, and a saved key. ([Streaming](streaming.md))
- [ ] In YouTube Studio the broadcast for today exists and is set to start automatically with the key.
- [ ] The **Stream** panel in the Present tab says where it will go. Press **Start streaming**.
- [ ] Look at **Stream health**: the rating is good, bitrate steady, no dropped frames growing.
- [ ] Open the broadcast on a phone *on the mobile network* (not on the church wifi) and check picture and sound. A few seconds of delay is normal.

## During the service

- [ ] Click the first slide of each item as it begins; use → or Space for the next slide and ← for the previous one. The arrows carry on from one item into the next.
- [ ] **Esc** or **Clear slide** to take the words off. **L** for the logo. **A** for an announcement.
- [ ] Watch the **Monitor** tab when someone else runs the camera or the sound; it shows every screen large.
- [ ] If a video plays, **Space** pauses it. Every screen stays in step.

## After the service

- [ ] **Stop streaming**. Wait until it says it has stopped before you close anything. A recording is saved as `.mkv` in the Videos folder.
- [ ] *(Lights)* Press **Blackout**, or recall a "Closed" scene.
- [ ] **Close all screens** (it asks first), then quit PreStreamer.

## If something goes wrong in the middle of the service

| What is happening | Do this |
| --- | --- |
| The wrong thing is on the screens | Press **Esc**, then click the right slide. |
| Something embarrassing is on the stream | Press the **Camera only** button (the camera icon in the Stream panel's header): the stream shows the live camera and nothing else, while the room keeps its slides. Press it again to bring the text back. |
| The room screens lost the picture | **Open all screens** again, or open just that screen with its **Open** button. |
| The stream dropped | Look at the Stream panel. Press **Stop streaming** and then **Start streaming** again. Whether YouTube carries on with the same broadcast depends on its settings; check in YouTube Studio. |
| The sound on the stream is bad or silent | Go to the **Mixer** tab: is a channel muted, is the master fader down? See [troubleshooting](troubleshooting.md). |
| The picture freezes on the computer | Do not close the program. Wait a few seconds, then try the keyboard. If you have to restart, it remembers the service and the screens that were open. A stream is **not** restarted automatically. |
