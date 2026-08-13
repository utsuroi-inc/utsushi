# 同梱している第三者ライブラリ

写し / utsushi は外部と通信しません。第三者ライブラリはCDNから読み込まず、
すべてビルド時に `dist/result.js` へバンドルしています（Manifest V3の要件でもあります）。

採用しているのは許諾的ライセンス（MIT / Zlib）のみで、GPL系は含みません
（`docs/requirements.md` §12.4）。

| ライブラリ | バージョン | ライセンス | 用途 | ライセンス全文 |
|---|---|---|---|---|
| [jsPDF](https://github.com/parallax/jsPDF) | 4.2.1 | MIT | PDF出力 | [jspdf.txt](jspdf.txt) |
| [@babel/runtime](https://github.com/babel/babel) | 7.29.7 | MIT | jsPDFのヘルパー | [babel-runtime.txt](babel-runtime.txt) |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | jsPDFの圧縮処理 | [fflate.txt](fflate.txt) |
| [fast-png](https://github.com/image-js/fast-png) | 6.4.0 | MIT | jsPDFのPNG解析 | [fast-png.txt](fast-png.txt) |
| [iobuffer](https://github.com/image-js/iobuffer) | 5.4.0 | MIT | fast-pngの依存 | [iobuffer.txt](iobuffer.txt) |
| [pako](https://github.com/nodeca/pako) | 2.2.0 | MIT / Zlib | fast-pngの依存 | [pako.txt](pako.txt) |

pakoは `lib/zlib` 配下がZlibライセンス、それ以外がMITです（同梱の全文はMIT部分。
Zlib部分の条項は上記リポジトリを参照）。いずれも許諾的ライセンスです。

## バンドルに含まれないもの

jsPDFは `html()` メソッド用に canvg / dompurify / html2canvas を動的importしますが、
写しはcanvasから直接PDFを生成するためこれらを使いません。ビルド時に空モジュールへ
差し替えて除外しています（`scripts/build.mjs`）。そのため `node_modules` には
存在しても配布物には含まれず、ここにライセンスを掲載していません。
