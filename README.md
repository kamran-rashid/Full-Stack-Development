# CSC413-8 Lab Assignments

**Name:** Md Kamran S Rashid
**Class:** 8 BSc CS (Hons)
**Register No.:** 2340236
**Institution:** CHRIST (Deemed to be University), Bengaluru

This repository holds my lab assignments for CSC413-8. Each lab lives in its own folder, with its own `README.md` that explains the work, how to run it, and what was tested.

## Repository layout

```
.
├── README.md          this file
├── LAB_1/             Lab 1
│   └── ...
├── LAB_2/             Lab 2: FinTrack context-aware media page
│   ├── index.html
│   ├── styles.css
│   ├── README.md
│   ├── assets/        images, video, captions
│   └── evidence/      screenshots and print preview
└── LAB_3/             Lab 3: FinTrack transaction tracker (JavaScript)
    ├── index.html
    ├── styles.css
    ├── js/            model, categoriser, insights, services, app
    ├── data/          sample bank statements (CSV)
    ├── README.md
    ├── AI_Log.docx
    └── evidence/      screenshots
Classroom_Tasks/
└── Classroom_Task_1/  Web APIs: FinTrack Pocket
    ├── index.html, styles.css, js/
    ├── tests/         automated test suite + results
    ├── README.md      documentation and test results
    └── evidence/      screenshots of the test cases
```

## Labs

| Lab | Folder | Topic | Technology | Details |
|---|---|---|---|---|
| 1 | [`LAB_1`](./LAB_1) | FinTrack personal-finance website (first version) | HTML, CSS, JavaScript | [LAB_1/README.md](./LAB_1) |
| 2 | [`LAB_2`](./LAB_2) | FinTrack: a context-aware media page that adapts to the viewer's screen, input, preferences and printing | HTML and CSS only, with no JavaScript | [LAB_2/README.md](./LAB_2/README.md) |
| 3 | [`LAB_3`](./LAB_3) | FinTrack tracker: transactions, statement import, budget forecast, pattern detection, live exchange rates | HTML, CSS and plain JavaScript (objects, arrays, Sets, Maps, events, async) | [LAB_3/README.md](./LAB_3/README.md) |

> Add a row to this table for every new lab, and keep the folder names in the form `LAB_<number>`.

## Classroom tasks

| Task | Folder | Topic | Technology | Details |
|---|---|---|---|---|
| 1 | [`Classroom_Tasks/Classroom_Task_1`](./Classroom_Tasks/Classroom_Task_1) | FinTrack Pocket: an expense diary that remembers where you spent, using Local Storage, Session Storage, IndexedDB, Geolocation and Web Workers | HTML, CSS, JavaScript (Web APIs) | [README](./Classroom_Tasks/Classroom_Task_1/README.md) |

## How to view a lab

Every lab folder is a static website, so no build step or install is needed.

1. Download or clone the repository:
   ```bash
   git clone <your-repository-url>
   cd <repository-name>
   ```
2. Open the lab's `index.html` in Chrome (Chrome is the reference browser for these labs).
3. For labs with video captions (Labs 2 and 3), serve the folder over HTTP instead of double-clicking the file, because Chrome blocks caption (`.vtt`) files on `file://`:
   ```bash
   cd LAB_2
   python3 -m http.server 8000
   # then open http://localhost:8000
   ```

The labs can also be published with GitHub Pages (Settings, then Pages, then deploy from the `main` branch). Each lab would then be at `https://<username>.github.io/<repository-name>/LAB_<number>/`.

## Conventions used in every lab

- One folder per lab, named `LAB_<number>`, with `index.html` as the entry point.
- A `README.md` inside each folder covering the aim, how to run it, what was tested, limitations, media credits and an AI usage log.
- Images, video, audio and captions are kept in an `assets/` folder, and all media is my own or licensed and credited in that lab's README.
- Evidence (screenshots and print previews) is kept in an `evidence/` folder where a lab requires it.

## Academic integrity and AI use

AI assistance was used for these labs and is recorded in each lab's README (tool, what was asked, what was kept, what was changed or rejected). I review and am able to explain and modify all the submitted code.

## Licence and credits

The code in this repository is my coursework. Third-party tools and models used for media are credited in the relevant lab's README (for example, Lab 2 credits the Kokoro-82M voice model, Apache-2.0).
