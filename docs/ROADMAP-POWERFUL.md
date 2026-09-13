# AegisX-Memory — Rencana Upgrade "Powerful"

> Dokumen perencanaan. Ini urutan kerja yang saya usulkan, bukan janji rilis.
> Setiap item punya alasan, perkiraan usaha, dan **cara membuktikan** ia selesai.
> Status batch yang sudah mendarat dicatat di Fase 0.

## Prinsip yang tidak boleh dilanggar

1. **Lokal dulu.** Tidak ada telemetry jaringan, tidak ada panggilan keluar. Data tinggal di `~/.aegisx`.
2. **Jujur soal batas.** Setiap permukaan (CLI, MCP, dashboard) menyebut apa yang **tidak** dimuat. Angka perkiraan diberi label perkiraan.
3. **Tidak pernah merusak milik user.** Config agent dan `AGENTS.md` hanya ditulis di dalam penanda, selalu di-backup, selalu idempoten.
4. **Tanpa kejutan.** Tidak ada penulisan ke repo atau `$HOME` tanpa perintah eksplisit.

## Cara membaca usaha

| Kode | Arti |
|---|---|
| **S** | satu berkas, < 1 jam, tes kecil |
| **M** | beberapa berkas, satu sesi |
| **L** | desain + tes + dokumentasi, beberapa sesi |

---

## Fase 0 — Yang sudah mendarat (batch ini)

| # | Item | Bukti |
|---|---|---|
| 0.1 | **Blok aturan ("soul") ditulis ulang** — kontrak eksplisit: kapan recall, cara membaca baris cakupan (`complete` / `(more exist)` / `budget dropped` / `N in handoff`), kapan `remember`, ke mana catatan pergi, cara memperbaiki memori, larangan rahasia | `src/cli/auto-setup.ts` · tes kontrak di `test/auto-setup.test.ts` |
| 0.2 | **Satu file untuk semua agent: `AGENTS.md`** di root repo — dibaca Codex, Cursor, Copilot, Gemini CLI, Zed tanpa setup per-klien | `installProjectRules()` · `mcp-config --project-rules [dir]` · 5 tes |
| 0.3 | **Wizard menanam file repo**, otomatis, dengan penjaga: tidak pernah menulis ke direktori home | `runSetupWizard(engine, { projectDir })` · 3 tes |
| 0.4 | **Lapisan salience di protokol MCP** — server mengirim `instructions` (kontrak ringkas, diinjeksikan klien ke konteks model) dan deskripsi tool yang *memerintah* ("call this BEFORE reading files"), bukan menyapa | `src/mcp/server.ts`, `src/mcp/http-server.ts`, `src/mcp/tools.ts` · bekerja tanpa kepatuhan pada file aturan |
| 0.5 | **Penulis config: Gemini CLI, Codex (TOML tanpa dependensi), Windsurf, VS Code** — SETUP_AGENTS kini 7 klien | `installForAgent` · 12 tes baru · doctor mendeteksi & menghitung cakupan ketujuhnya |
| 0.6 | **Installer membersihkan sisa uninstall-nya sendiri** — `setup`/`auto` menyapu `*.aegisx-bak` yang berkas aslinya sudah hilang (hanya di direktori yang AegisX tulis; backup hidup tidak disentuh; orphan yang bukan milik kita dilaporkan, bukan dihapus) plus direktori hantu yang ia hidupkan, terdalam dulu | round trip 7 agen meninggalkan 13 backup + 9 direktori kosong yang membuat "bersih" tidak pernah benar | M | `sweepOrphanedBackups()` · 7 tes + round trip nyata (13 dibersihkan, orphan 0) |
| 0.7 | **Tes paritas dokumen EN/ID** — outline heading satu-per-satu, ToC ↔ seksi bernomor, fence berimbang (komentar `#` di dalam fence bukan heading) | dua README mulai menyimpang tanpa ada yang menangkap | S | `test/docs.test.ts` (6 tes); mutasi uji: tambah 1 heading → 3 tes gagal |

Biaya blok: **±690 token**, dibaca sekali per sesi per repo.

---

## Fase 1 — "Satu perintah, semua agent" (P0)

Hari ini **tujuh** klien punya penulis config: Hermes, Claude, Cursor, Gemini CLI, Codex, Windsurf, VS Code. Yang tersisa di fase ini hanya kelengkapan: file aturan per-klien, mode non-interaktif, uninstall.

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| ~~1.1~~ | ✅ **Gemini CLI** — `~/.gemini/settings.json` → `mcpServers` (dihormati `GEMINI_CLI_HOME`) | — | — | mendarat (Fase 0, item 0.5) |
| ~~1.2~~ | ✅ **Codex CLI** — `~/.codex/config.toml` → `[mcp_servers.aegisx-memory]`, append murni, tanpa dependensi | — | — | mendarat (Fase 0, item 0.5) |
| 1.3 | **Cline** dan **Zed** (`context_servers`) — dua penulis JSON tersisa | JSON semuanya | S ×2 | satu tes per jalur |
| 1.4 | **File aturan per-klien di repo**: `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/aegisx-memory.mdc`, `.github/copilot-instructions.md` — dari blok yang sama | agent yang membaca file repo-nya sendiri tetap dapat kontraknya | S | satu tes per jalur |
| ~~1.5~~ | ✅ **`setup --yes --agent <name[,name]>`** non-interaktif | untuk dotfiles/CI, dan untuk menuliskan setup ke skrip | S | tes: satu perintah, tidak ada tanya — mendarat |
| ~~1.6~~ | ✅ **`uninstall --agent <name>`** — cabut entri MCP + blok aturan + hook, dengan backup; mirror installer (repo AGENTS.md, hook project, dan hook Hermes ikut dicabut) | sekarang §17 hanya instruksi manual; memasang lebih mudah daripada melepas | M | tes: file kembali seperti semula (17 tes uninstall) — mendarat |
| ~~1.9~~ | ✅ **`aegisxmemory auto`** — deteksi otomatis agent terpasang + wiring + daemon MCP HTTP & dashboard (`--status`/`--down`), dan wizard memasang hook Hermes (`pre_llm_call`/`pre_verify`) secara otomatis | langkah terakhir onboarding kini nol pertanyaan: install → `auto` → restart agent | M | 10 tes baru (`test/auto.test.ts`) + uji live sandbox — mendarat |
| ~~1.7~~ | ✅ **`doctor` memverifikasi registrasi** — entri yang berkas entry-nya hilang → `fail`, entri yang bukan AegisX → warn, dan hanya agen yang **benar-benar ada** di mesin yang ditagih; agen tak terpasang dibisukan, sementara baris laporannya tetap menyebut apa yang ditemukan | "sudah terinstall" tanpa verifikasi adalah klaim kosong — dan menuduh agen yang tidak ada melatih orang mengabaikan laporan | M | tes: entri hilang → fail, entri asing → warn, mesin-hermes-saja → senyap — mendarat |
| ~~1.10~~ | ✅ **`doctor` mencocokkan versi entry** — entri dijalankan (`node <entry> --version`) dan stempelnya dibandingkan dengan build yang sedang menjalankan laporan; kalau stempel sama tapi bundel lebih tua dari `src/`, itu ditandai "rebuild dengan `npm run build`". Probe yang gagal tidak pernah jadi putusan | berkas ada ≠ build yang dipakai benar, dan `dist` basi tetap terpakai tanpa satu pun error | S | tes: stempel beda → warn, entri lebih tua dari sumber → warn, probe gagal → pass — mendarat di `src/cli/version.ts` + `doctor.ts` |
| 1.8 | **Pilihan bahasa wizard** (`--lang en\|id`) | pesan CLI saat ini selalu Indonesia | S | tes: output `en` tidak memuat teks Indonesia |

---

## Fase 2 — Otomasi yang tidak bergantung disiplin model (P1)

Blok aturan bekerja **kalau model patuh**. Hook bekerja **kalau agent memanggilnya**, tanpa bergantung kepatuhan — dengan satu syarat yang ditemukan lewat uji live: **dialek payload-nya harus benar untuk agent itu**. Hook yang terpasang, exit 0, dan "sehat" di doctor tapi menyuntik nol lebih buruk daripada tidak ada hook sama sekali.

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| ~~2.1~~ | ✅ **`aegisxmemory hook session-start` / `hook session-end`** — **dua dialek** lewat `--client claude\|hermes`: Claude Code (SessionStart → `hookSpecificOutput.additionalContext`, Stop → `{decision:block,reason}`) dan Hermes asli (`{"context": …}`, `{action,message}`); skrip yang dipasang installer memangku `--client hermes` | Hermes hanya membaca `context` — bentuk Claude **diabaikan tanpa error**, jadi hook "sehat" itu tidak menyuntik apa pun | M | 22+ tes di `test/hooks.test.ts` (termasuk satu tes yang gagal bila flag itu hilang) + uji live dua sesi Hermes asli — mendarat |
| ~~2.5~~ | ✅ **Skrip hook ditulis hanya saat byte-nya berubah** — Hermes membandingkan `script_mtime_at_approval`, jadi menulis ulang tanpa syarat memicu *"script modified since approval"* setiap kali `auto`/`setup` dijalankan walau isinya sama | peringatan palsu yang selalu menyala = peringatan yang diabaikan | S | tes: re-install idempoten tidak menyentuh mtime; badan berubah tetap ditulis — mendarat |
| ~~2.6~~ | ✅ **Hook recall menyuntik di turn pertama saja** — skrip membaca `extra.is_first_turn`; field yang absen (Hermes lama, dijalankan manual, klien lain) tetap menyuntik, jadi perubahan bentuk payload menurun ke "sedikit mahal", bukan ke senyap | Hermes memanggil `pre_llm_call` tiap turn dan tiap pesan user disegel dengan apa yang dikirim, jadi tanpa gerbang blok memori terkirim ulang di setiap turn sesi panjang | S | tes: `is_first_turn:true` → JSON, `false` → stdout kosong, absen → JSON |
| ~~2.2~~ | ✅ **Pasang hook: `hook session-start --install [--project]`** + tawaran wizard untuk target claude (dengan backup, idempoten, marker) | supaya otomatis benar-benar otomatis | M | tes installer (created/merged/unchanged/error) + 3 tes wizard |
| ~~2.3~~ | ✅ **Auto-index berbatas waktu di session-start** — `Indexer.scan` menerima deadline kooperatif (diperiksa antar file, commit atomik awalan, resume dari hash tersimpan); `indexRepoWithDeadline` di Engine | pengguna baru tidak perlu tahu `index`; jujur saat anggaran habis (`null` = "belum selesai", bukan gagal) | M | 3 tes deadline di `test/engine.test.ts` |
| ~~2.7~~ | ✅ **Hook `post_llm_call` menyimpan handoff sendiri** — `aegisx-autosave.sh` membaca `conversation_history` + `assistant_response` yang Hermes sudah kirim dan menurunkan handoff dengan aturan saja (tanpa model, tanpa jaringan). Satu baris per sesi yang **diperbarui di tempat** setiap turn: pointer (repo, id sesi) → row id + sidik jari isi disimpan di `meta`, jadi turn tanpa hal baru tidak menulis apa pun dan sesi 40 turn tetap meninggalkan satu handoff. `AEGISX_AUTOSAVE=0` mematikannya tanpa melepas hook | sisi baca sudah deterministik sejak 2.1; sisi **simpan** masih menunggu model menuruti nudge — dan sesi yang mengabaikannya hilang tanpa jejak sama sekali (terukur: 0 handoff dari sesi uji 4-turn) | M | 32 tes baru (`test/handoff.test.ts`, `test/autosave.test.ts`) + uji live: dua sesi Hermes dengan `tool_call_count=0` tetap meninggalkan handoff — mendarat |
| ~~2.4~~ | ✅ **`hook post-edit`** → indeks inkremental sekali jalan | index tetap segar tanpa daemon `watch` | S | tes: berkas berubah → simbol muncul |

---

## Fase 3 — Kualitas memori: menemukan & mempercayai (P1)

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| ~~3.1~~ | ✅ **Peta sinonim diperluas** — `gagal` kini satu kelompok dengan `error`/`bug`/`galat`/`fail`, plus `salah`, `rusak`, `batal`, `langganan`, `hapus`, `simpan`, … (kelompok tidak saling menaut, jadi kata sekonsep harus sekelompok) | terukur dulu: `database`→`sqlite` ketemu, `gagal`→`error` **tidak** | S | mendarat di `src/core/fts.ts` (`SYNONYM_GROUPS`) |
| ~~3.2~~ | ✅ **Recall jujur saat nol hasil** — `0 facts (some exist, none matched)`, `0 knowledge (… )`, `0 symbols (some indexed, none matched)` | laporan kosong dulu terbaca seperti `complete` — menyesatkan | S | mendarat di `src/core/engine.ts` + tes |
| 3.3 | **`knowledge edit <id>`** | memperbaiki catatan tanpa hapus + tulis ulang | S | tes: judul/isi berubah, id sama |
| 3.4 | **`aegisxmemory import`** (round-trip `export --format json`) | export ada, jalur baliknya tidak — pindah mesin belum utuh | M | tes: export → import → isi identik |
| 3.5 | **Deteksi kemiripan saat save** (judul sama sudah upsert; isi mirip belum) | mencegah 5 catatan yang mengatakan hal yang sama | M | tes: dua catatan mirip → dilaporkan, tidak diam-diam |
| 3.6 | **Fakta basi**: tandai fakta yang tak tersentuh > N hari di recall/`doctor` | memori lama yang salah lebih berbahaya daripada kosong | S | tes: fakta tua ditandai |
| 3.7 | **`stats --days N`** | tren harian di terminal, bukan hanya dashboard | S | tes: angka per hari |

---

## Fase 4 — Dashboard yang bisa dipakai orang awam (P1)

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| 4.1 | **Panel bantuan** (arti hit/miss/budget/estimasi) EN+ID | grafik tanpa legenda adalah teka-teki | S | tes: panel ada di HTML tersaji |
| 4.2 | **Tren hit-rate harian** | satu angka total tidak menunjukkan arah | M | tes: seri 7 hari benar |
| 4.3 | **Edit entri knowledge dari UI** (POST update, postur keamanan sama dengan delete) | delete sudah ada, koreksi belum | M | tes: guard 405/415/403 + update sukses |
| ~~4.4~~ | ✅ **Picker repo + filter kind (segmented) + kotak pencarian** di halaman browser memori | halaman browser tanpa pencarian hanya berguna untuk < 20 entri | M | mendarat di `src/cli/dashboard.ts` (`#mem-repo`, `#mem-kinds`, `#mem-search`) |
| 4.5 | **Tombol export dari dashboard** (md/json) | jalur cadangan yang tidak butuh terminal | S | tes: endpoint mengembalikan isi |
| 4.6 | **Perbaikan grafik**: label panjang, filter kind persisten, mode fokus | sudah diperbaiki sebagian; ini sisa yang terlihat di layar user | S | tes: state bertahan setelah reload |

---

## Fase 5 — Distribusi & rilis yang jujur (P1/P2)

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| ~~5.1~~ | ✅ **Bump versi + tag git per rilis** (`v1.30.0`, …) — versi kini **1.30.0** di `package.json`, `--version`, installer, dan handshake MCP (satu konstanta di `src/core/version.ts`, dijaga tes anti-drift) | installer mencetak `Version: 1.0.0` sejak commit pertama — pernah menyesatkan user | S | mendarat: `aegisxmemory --version` → `1.30.0 (…)`; prosedur tag ada di README §Install |
| ~~5.2~~ | ✅ **`--version` memuat commit + tanggal build** | satu-satunya cara user tahu build mana yang ia pakai | S | nyata: `1.0.0 (e6b670e · 2026-09-13)` — nomor versinya sendiri masih 1.0.0 (lihat 5.1) |
| 5.3 | **`doctor` melaporkan "ketinggalan N commit"** (best-effort, berbatas waktu, gagal senyap saat offline) | Hermes melakukannya untuk dirinya; kita belum | S | tes: offline → tidak error |
| 5.4 | **`install.ps1`** untuk Windows | sekarang hanya `install.sh` | M | jalur PowerShell teruji di Windows |
| 5.5 | **`aegisxmemory update`** | update tanpa mengingat URL | S | tes: menjalankan jalur git pull + build |
| 5.6 | **Publish npm** (`npx aegisx-memory`) | jalur pasang paling pendek — keputusan pemilik repo | M | paket bisa dipasang dari npm |
| 5.7 | **Changelog otomatis dari commit** | RFC menjawab "kenapa", changelog menjawab "sejak kapan" | S | `CHANGELOG.md` dihasilkan |

---

## Fase 6 — Ketahanan & skala (P2)

| # | Item | Kenapa | Usaha | Bukti selesai |
|---|---|---|---|---|
| 6.1 | **`backup` / `restore`** (API backup SQLite + cek integritas) | memori adalah satu berkas; menyalinnya saat WAL hidup berisiko | M | tes: backup → restore → identik |
| ~~6.2~~ | ✅ **Izin rumah memori diperiksa & diperbaiki** — temuan nyata: rumah lama di mesin ini `0775`, rumah baru `0700` | direktori yang bisa dibaca grup membocorkan metadata proyek | S | mendarat: `doctor` melaporkan, `doctor --fix` men-`chmod 700` |
| 6.3 | **Konkurensi tulis** (dua agent bersamaan) + `busy_timeout` | dua agent pada satu repo itu normal | M | tes: 2 penulis paralel, tidak ada kunci mati |
| 6.4 | **`vacuum`/`analyze` berkala** + ukuran DB di `doctor` | memori tumbuh selamanya tanpa perawatan | S | `doctor` menampilkan ukuran |
| 6.5 | **Uji beban indeks** (repo besar, mis. 50k berkas) + laporan waktu | janji "hemat token" harus diukur pada repo nyata | M | laporan angka, bukan klaim |
| 6.6 | **Migrasi mesin** = `export` + `import` (lihat 3.4) | satu jalur, bukan dua | S | — |

---

## Fase 7 — Retrieval hybrid / pencarian makna (butuh keputusan Anda) — v2

Masalahnya dua kelas, obatnya beda:

- **Kelas 1 — sinonim yang belum dipetakan** → cukup daftar kata (item 3.1). Murah, pasti.
- **Kelas 2 — parafrase tanpa satu kata pun sama** → hanya model makna yang bisa.

| Opsi | Isi | Yang berubah di mesin user |
|---|---|---|
| **A** | tulis rencananya saja di RFC | tidak ada |
| **C** | perkuat leksikal (sinonim, batang kata, operator) | tidak ada unduhan |
| **B** | pencarian vektor lokal (model ONNX ±30–120 MB + runtime) | janji "nol jaringan" berubah menjadi "unduhan model sekali"; gagal → ganti model, bukan satu baris |

Rekomendasi: **A + C sekarang**, B ditahan sampai ada pengukuran pada data Indonesia nyata.

---

## Anti-goals (sengaja tidak dikerjakan)

- Telemetry/analytics jaringan apa pun.
- Sinkronisasi awan & multi-user di v1 (v3, dengan enkripsi).
- Menyimpan kode mentah atau isi berkas ke memori.
- Menjanjikan penghematan token yang tidak terukur.

## Definisi selesai (metrik, bukan perasaan)

1. Dari nol → memori jalan: **≤ 2 perintah, ≤ 3 menit**.
2. Setiap agent populer punya jalur: penulis config khusus **atau** `AGENTS.md`.
3. Semua permukaan menyebut apa yang tidak dimuat, termasuk saat hasil nol.
4. Hit rate naik di minggu pertama pemakaian normal (terlihat di dashboard).
5. Nol kebocoran rahasia di seluruh jalur tulis (sudah ada pemindai; dijaga tes).

## Urutan batch yang saya sarankan

| Batch | Isi | Kenapa urutan ini |
|---|---|---|
| ~~A — jujur & cepat~~ | 3.2, 3.1, 1.7, 5.2, 6.2 | ✅ mendarat semua — statusnya ada di tabel fase masing-masing |
| **B — satu perintah semua agent** | sisa 1.3, 1.4, 1.8 (1.1, 1.2, 1.5, 1.6, 1.9 sudah ✅) | inti keluhan "ribet buat orang awam" |
| **C — kedalaman** | 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.5, 4.6, 5.1, 6.1 (4.4 sudah ✅) | memperluas yang sudah kuat |
