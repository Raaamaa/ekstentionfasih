# Fasih Auto-Approval SE2026 (Chrome Extension)

Ekstensi browser Chrome untuk melakukan **Persetujuan Otomatis (Auto-Approval)** kuesioner pada sistem **FASIH-SM BPS (`https://fasih-sm.bps.go.id`)**. 

Mengubah status dokumen dari **`Edited by Admin Kabupaten`** menjadi **`Completed by Admin Kabupaten`** secara berurutan dan aman tanpa perlu input manual nomor SLS 16-digit.

---

## Fitur Utama

- **Zero-Manual Input (Otomatis Penuh)**: Menangkap parameter filter wilayah dan kriteria status secara otomatis dari tab aktif Web Fasih BPS. Tidak perlu mengetik nomor SLS atau Group ID.
- **Uji Coba Tunggal ("🧪 Tes 1 Data")**: Tombol pengujian mandiri untuk memproses tepat 1 kuesioner pertama yang berstatus *Edited by Admin*, sehingga pengguna dapat memverifikasi keberhasilan status di Web Fasih sebelum menjalankan approve massal.
- **State Transition Guard**: Dirancang khusus memproses transisi `Edited by Admin Kabupaten` ➔ `Completed by Admin Kabupaten`. Data yang sudah `Completed` otomatis dilewati (*skip* aman).
- **Anti-Bot Protection (Human Rhythm)**:
  - Default pacing jeda 1500ms dengan *dynamic jitter* (fluktuasi waktu acak).
  - Jeda istirahat berkala (*cooldown pause*) setiap 12 data untuk meniru ritme kerja manusia.
  - Penanganan adaptif HTTP 429 yang mematuhi header `Retry-After` dari server BPS.
- **Integritas & Checkpoint Resume**: Progres tersimpan secara real-time di `chrome.storage.local`. Jika koneksi terputus atau sesi login habis, dapat dilanjutkan kembali kapan saja melalui tombol **Resume**.
- **Mode Dry-Run (Simulasi)**: Uji coba aman untuk memverifikasi daftar data sebelum melakukan eksekusi live ke server.

---

## Cara Instalasi di Chrome

1. Unduh repositori ini (klik tombol hijau **Code** ➔ **Download ZIP**).
2. Ekstrak file ZIP di komputer Anda (misal menghasilkan folder `ekstentionfasih-main`).
3. Buka browser Chrome, lalu ketik di bilah alamat:
   ```
   chrome://extensions
   ```
4. Aktifkan **Mode Pengembang / Developer mode** di pojok kanan atas.
5. Klik tombol **Muat yang belum dibongkar / Load unpacked** di pojok kiri atas.
6. Pilih folder **`src`** yang ada di dalam folder hasil ekstraksi (folder yang berisi `manifest.json`).
7. Ekstensi siap digunakan!

---

## Cara Penggunaan

1. Buka tab Web Fasih di browser Anda: `https://fasih-sm.bps.go.id/app/surveys/.../data`.
2. Gunakan filter bawaan Web Fasih (wilayah dan filter status untuk data yang ingin di-approve).
3. Buka **Side Panel** ekstensi:
   - Indikator di Langkah 1 akan otomatis menyerap filter: **`● Filter Web Terdeteksi`**.
4. Klik tombol **`🔍 Cek Data Target`** untuk melihat sampel kuesioner yang terdeteksi.
5. **(Rekomendasi)** Klik tombol **`🧪 Tes Approve 1 Data`** untuk memproses tepat 1 data terlebih dahulu. Buka tab Web Fasih dan refresh tabel untuk memastikan statusnya telah menjadi *Completed by Admin Kabupaten*.
6. Jika sudah puas dengan hasil uji coba 1 data, klik tombol **`▶ Jalankan Auto-Approve (Semua)`** untuk memproses seluruh antrean secara massal.
