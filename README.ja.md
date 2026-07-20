# Sudachi Lookup

[English](README.md) | 日本語

Sudachi Lookupは、[SudachiDict](https://github.com/WorksApplications/SudachiDict)
の日本語辞書をブラウザ内で検索・閲覧するための静的Webアプリケーションです。
検索語をサーバーへ送信せず、キー入力に追随して結果を更新します。各見出し語では、
SudachiのStructure情報とA・B・C各単位の分割を確認できます。

Cloudflare Pagesでの配信を前提としており、アプリケーションサーバー、検索API、
データベース、実行時の辞書サービスは必要ありません。

## 主な機能

- 表層形・辞書形・正規化形・読み形に対する前方一致検索
- ひらがな・カタカナの両方に対応し、入力された文字種を優先する順位付け
- Web Workerによる段階的な検索結果表示とレコード読み込み
- クリックできる複合語要素と、展開可能なA・B・C各単位の分割表示
- 見出し語ごとのSmall・Core・Full収録区分（レコードごとの追加領域は不使用）
- 選択した直接のStructure要素を先頭または末尾に持つ語の構造一致検索
- 検索に必要な場合だけ取得されるコンパクトなバイナリshard
- バージョンを固定したSudachiDict公式パッケージから再生成できるCore・Fullデータ
- 日本語の画面表示、読み込み・エラー状態、アクセシビリティラベル

## 仕組み

```text
バージョンを固定したSudachiDict公式パッケージ
        |
        v
system.dicのチェックサム検証
        |
        v
Rustによる中間形式の書き出しとブラウザ形式の生成
        |
        +-- 初期表示用bootstrap
        +-- 前方一致検索shard
        +-- Structure・A/B境界を含む見出し語レコード
        +-- 先頭・末尾の構造一致用posting
        |
        v
Cloudflare Pages -> Web Worker -> 順位付けされた検索結果
```

配信する辞書には、JavaScriptやJSONのレコードではなく、バージョン付きの
バイナリファイルを使用します。起動時には小さなbootstrapだけを読み込み、
検索語に対応する検索shard、見出し語レコード、構造一致データを必要に応じて
取得します。設計の詳細は
[アーキテクチャとプロダクト仕様](docs/ja/architecture.md)を参照してください。

## ローカル開発

Node.js 22以降が必要です。

```sh
npm ci
npm run dev
```

生成済みのCore・Fullデータがない場合は、リポジトリに含まれる決定的な
サンプル辞書を使用します。サンプルを使った一通りの検証は次のコマンドで実行できます。

```sh
npm run check
```

モジュールWorkerと辞書の取得にはHTTPが必要なため、`file://`では開かないでください。

## 公式辞書からローカル生成する

対象リリースは
[`config/dictionary-release.json`](config/dictionary-release.json)で一元管理しています。
インストール時に、公式パッケージ内の`system.dic`のSHA-256を検証してから
書き出しを行います。

Core:

```sh
npm run data:core:install
npm run data:core
npm run data:core:web
npm run data:core:validate
```

Full:

```sh
npm run data:full:install
npm run data:full
npm run data:full:web
npm run data:full:validate
```

中間形式、レポート、生成したCore・Fullのブラウザ用データはGitの管理対象外です。
複数のデータがある場合、アプリケーションはFull、Core、サンプルの順に使用します。

## デプロイ

Pages用の組み立てでは、必ず一つのeditionを明示的に選びます。

```sh
npm run build:pages -- --edition sample
npm run build:pages -- --edition core
npm run build:pages -- --edition full
```

Fullの公開サイトは[sudachi.vocrf.net](https://sudachi.vocrf.net)です。
リリース確認と比較のため、固定されたプレビュー環境も維持しています。

- [サンプル](https://staging.sudachi-lookup.pages.dev)
- [Core](https://core-staging.sudachi-lookup.pages.dev)
- [Full](https://full-staging.sudachi-lookup.pages.dev)

通常のGitHubへのpushとpull requestでは、決定的なサンプルだけを使って検証します。
Fullの本番workflowは手動で開始し、公式辞書のインストールと検証、全ブラウザ用データの
生成、整合性検証を行ってからPagesの`main` branchへデプロイします。
GitHubに`production` environmentを作成し、`CLOUDFLARE_ACCOUNT_ID`と
`CLOUDFLARE_API_TOKEN`をsecretとして設定する必要があります。

リリースとデプロイの詳細は
[開発・デプロイ手順](docs/ja/development.md)を参照してください。

## リポジトリ構成

```text
app/                  ブラウザアプリケーションとWeb Worker
config/               固定した辞書リリース情報
tools/dictionary/     書き出し・ブラウザ形式生成・検証ツール
tools/site/           Pages用静的ファイルの組み立てとデプロイツール
public/data/sample/   開発用の決定的なfixture
.github/workflows/    サンプルCIと手動のFull本番リリース
docs/                 設計・計測結果・インタラクション方針
legal/                SudachiDictのライセンスと帰属表示
```

## ドキュメント

内容に一時的な差異がある場合は、英語版を正本とします。人が読むことを目的とした
設計文書にはすべて日本語版を用意し、日本語文書間のリンクも日本語版へ向けています。

- [アーキテクチャとプロダクト仕様](docs/ja/architecture.md)
- [開発・デプロイ手順](docs/ja/development.md)
- [初期実現可能性調査](docs/ja/feasibility.md)
- [複合語ナビゲーション](docs/ja/compound-navigation.md)
- [構造一致検索](docs/ja/structure-match-lookup.md)
- [正規見出し語フィルタリング](docs/ja/canonical-headword-filtering.md)
- [コンパクトな分割境界形式](docs/ja/split-boundary-format.md)
- [辞書エディションの収録区分](docs/ja/edition-membership.md)

## ライセンス

このリポジトリで作成したソースコードは
[Apache License 2.0](LICENSE)で提供します。

SudachiDictはApache License 2.0で配布され、UniDicおよびNEologdの一部を
含みます。辞書の派生物を配布する際は、
[`legal/sudachidict`](legal/sudachidict)に収録した該当する表示を保持する必要があります。
Sudachi Lookupは独立したプロジェクトであり、Works Applications Co., Ltd.との
提携または同社による承認を受けたものではありません。
