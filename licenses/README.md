# 同梱している第三者ライブラリ

写し / utsushi は、実行時に第三者ライブラリをCDNから読み込まず、ビルド時に `dist/result.js` へバンドルします。

採用しているのは許諾的ライセンス（MIT / Zlib）のライブラリです。

| ライブラリ | バージョン | ライセンス | 用途 | ライセンス全文 |
|---|---:|---|---|---|
| [jsPDF](https://github.com/parallax/jsPDF) | 4.2.1 | MIT | PDF出力 | [jspdf.txt](jspdf.txt) |
| [@babel/runtime](https://github.com/babel/babel) | 7.29.7 | MIT | jsPDFのヘルパー | [babel-runtime.txt](babel-runtime.txt) |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | jsPDFの圧縮処理 | [fflate.txt](fflate.txt) |
| [fast-png](https://github.com/image-js/fast-png) | 6.4.0 | MIT | jsPDFのPNG解析 | [fast-png.txt](fast-png.txt) |
| [iobuffer](https://github.com/image-js/iobuffer) | 5.4.0 | MIT | fast-pngの依存 | [iobuffer.txt](iobuffer.txt) |
| [pako](https://github.com/nodeca/pako) | 2.2.0 | MIT / Zlib | fast-pngの依存 | [pako.txt](pako.txt) / [zlib.txt](zlib.txt) |

pakoは通常部分がMIT、zlib由来部分がZlibライセンスです。両ライセンスの本文をこのディレクトリに同梱しています。

## バンドルに含まれないもの

jsPDFは `html()` 用に canvg / dompurify / html2canvas を動的importしますが、写しはcanvasから直接PDFを生成するため利用しません。`scripts/build.mjs` で空モジュールに差し替えて配布バンドルから除外します。
