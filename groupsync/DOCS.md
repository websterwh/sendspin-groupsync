# GroupSync

Measures how far your Music Assistant speakers are out of sync, using your phone's microphone, and tells you
(or optionally sets) the delay to correct each one.

## Setup

1. Set the options below and start the add-on, then open **GroupSync** from the sidebar.
2. In Music Assistant, put the speakers you want to compare into one sync group.
3. Select the speakers, start, and tap *Measure* next to each one.

## Options

| Option | |
| --- | --- |
| `ma_url` | Music Assistant address, e.g. `192.168.1.9:8095` |
| `ma_token` | A long-lived access token from Music Assistant (profile → Long-lived access tokens). Stays on the server; the page never sees it. |
| `media_host` | Only if Music Assistant can't reach the add-on at its own address: the Home Assistant host's IP. Leave empty normally. |

## Microphone

Browsers only allow the microphone on secure pages. Open Home Assistant over **HTTPS** (Nabu Casa, DuckDNS or
your own certificate). Over plain `http://` the Home Assistant app itself says the microphone is blocked, and
GroupSync can't record.

## Network

Music Assistant fetches the click track from this add-on on port **5174** (plain HTTP). It is mapped by default.
