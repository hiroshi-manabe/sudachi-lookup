[English](../development.md) | 日本語

# 開発と展開のワークフロー

## 概要

Sudachi Lookup には、構築する 2 つの異なる製品があります。

1. ブラウザで検索可能なシャードを含む、再現可能な辞書アーティファクト。
2. 選択した辞書アーティファクトを使用する静的Webアプリケーション。

それらを分離しておくことは不可欠です。フロントエンドの作業は高速である必要がありますが、大規模な SudachiDict Full ビルドは頻度を低くし、厳密に検証し、多くのサイト展開で再利用する必要があります。

## 環境

|ステージ |環境 |データセット |目的 |
| --- | --- | --- | --- |
|データの実現可能性 |ローカル CLI |ピン留めされたコア |抽出、関係、形式、サイズを検証する |
|ブラウザ開発 |ローカルHTTPサーバー |小型器具 |高速 UI、ワーカー、ランキング、およびアクセシビリティの機能 |
|ホストされたプレビュー | `pages.dev` |小さな治具または準備されたコア |実際の転送とホスティングの動作をテストする |
|リリース候補 |プレビュー URL またはステージング サブドメイン |準備されたコアまたはフル |実際のネットワーク上で完全なリリースを検証する |
|制作 |カスタムドメイン |検証済みのリリース アーティファクト |公共サービス |

## ローカル開発

Vite を TypeScript または同等の軽量静的ツールチェーンとともに使用します。アプリケーションにはサーバー側のレンダリングやアプリケーション サーバーは必要ありません。

ターゲットのコマンド サーフェスは次のとおりです。

```text
npm run data:sample   Generate or copy the deterministic browser fixture
npm run data:small:install Install and verify the pinned official Small package
npm run data:small    Export an installed Small dictionary to a neutral stream
npm run data:core:install Install and verify the pinned official Core package
npm run data:core     Export an installed Core dictionary to a neutral stream
npm run data:core:web Build locally served Core browser shards
npm run data:full:install Install and verify the pinned official Full package
npm run data:full     Export an installed Full dictionary to a neutral stream
npm run data:full:web Build locally served Full browser shards
npm run data:editions:verify Verify the cumulative Small/Core/Full word-ID ranges
npm run dev           Start the local HTTP development server
npm test              Run unit, integrity, and search fixtures
npm run build         Produce deployable static output
npm run preview       Serve the production output locally
```

サンプル データセットには以下が含まれている必要があります。

- 表面の完全一致と接頭辞一致
- ディクショナリと正規化された形式のエイリアス
- ひらがなとカタカナの読みが一致します
- 区別しなければならない同形異義語
- 分割情報のないエントリ
- B と A の両方の分割を持つ代表的な C エントリ
- 構造一致フィクスチャは、最初と最後の位置をカバーし、なし、1 つ、複数、および広範な正規の親リストを持ちます。
- Unicode の正規化と句読点のエッジ ケース

フィクスチャは、ほぼ瞬時に再生成できるほど小さく、UI テストで正確な順序を確認できるほど安定している必要があります。

リリース ID は `config/dictionary-release.json` に集中されます。公式パッケージのバージョン、インストールされている各 `system.dic` の SHA-256、互換性のある Rust Sudachi リビジョン、およびブラウザー形式を固定します。インストール コマンドは公式の Python パッケージを取得しますが、解凍された辞書のチェックサムが異なる場合はそれを拒否します。 `npm run data:core` と `npm run data:full` は、`reports/` で無視されたアーティファクトをエクスポートする前に、同じチェックサムを個別に検証します。

ニュートラル エクスポートが存在すると、`npm run data:core:web` はバージョン管理されたブラウザー データセットを `public/data/releases/` の下に書き込みます。これらのアセットも Git によって無視されます。そのコア マニフェストが存在する場合、ローカル アプリはそれを自動的に選択します。それ以外の場合は、サンプル フィクスチャに戻ります。完全なローカル シーケンスは次のとおりです。

```sh
npm run data:core:install
npm run data:core
npm run data:core:web
npm run dev
```

完全なコマンドは、同じエクスポーターとブラウザー形式ビルダーを使用します。生成された両方のエディションがローカルに存在する場合、アプリケーションは現在完全を優先します。アセットが使用できなくなると、コアを介してサンプル フィクスチャにフォールバックします。

Fullの本番リリースでは、SmallとCoreも書き出して`npm run data:editions:verify`を実行します。これにより、SmallがCoreの先頭範囲と完全に一致し、CoreがFullの先頭範囲と完全に一致することを確認してから、マニフェストに二つの収録区分境界を記録します。

`file://` を開発環境として使用しないでください。 HTTP サーバーは、モジュール ワーカー、相対的な `fetch` 呼び出し、MIME タイプ、および現実的なアセットの読み込みを実行するために必要です。

## 最初の垂直スライス

ビジュアルの磨き上げやホスティングのセットアップの前に、1 つの完全なパスを実装します。

```text
real Sudachi records
    -> extractor
    -> a few binary shards
    -> Web Worker fetch and decode
    -> prefix search and ranking
    -> visible result
    -> expandable A/B/C segmentation
```

実稼働ビルドがローカルで動作し、古いワーカーの応答が新しいクエリを上書きできない場合、スライスは完了します。

## Cloudflare Pagesを作成するタイミング

垂直スライスが完了したら、Pages プロジェクトを作成します。そのマイルストーンは現在、ブラウザーで生成された辞書データを検索し、構造と A/B/C 関係をナビゲートできるようになりました。したがって、次の開発マイルストーンは、追加のローカル専用インフラストラクチャではなく、ホスト型プレビューです。

Pages を使用して以下をテストします。

- Brotli または gzip 転送サイズ
- バイナリコンテンツタイプ
- `_headers` の動作
- 不変アセットのキャッシュとマニフェストの再検証
- コールドクエリとウォームクエリのレイテンシ
- モバイルネットワークの動作
- 合計ファイル数と最大アセット サイズ

開発中は、プロジェクトの `pages.dev` アドレスと、Wrangler によって作成されたブランチ プレビュー URL を使用します。プレビュー展開では、CSS またはインタラクションの変更によってフルがトリガーされたり転送されたりしないように、デフォルトでサンプル フィクスチャを使用する必要があります。

## Pages デプロイメント出力

アプリケーションの動作と専用の静的出力は、ホストされたプレビュー用に準備が整っています。通常のアプリケーション ビルドはまだ Pages アーティファクトではありません。

`npm run build` は現在、Vinext ワーカー指向のパッケージを生成しています。

```text
dist/client/          Browser assets, but no standalone index.html
dist/server/index.js  Worker entry point
```

さらに、生成されたコア アセットとフル アセットを含む作業ツリーで作成されたビルドは、両方のエディションを `dist/` にコピーする場合があります。そのため、出力がローカル状態に依存することになり、サンプル フィクスチャのみが意図されていた場合に誤って数ギガバイトをアップロードする可能性があります。

実装された Pages アセンブリ コマンドには明示的な編集が必要です。

```text
npm run build:pages -- --edition sample
npm run build:pages -- --edition core
npm run build:pages -- --edition full
```

各コマンドは、スタンドアロン HTML エントリ ポイント、アプリケーション アセット、`_headers`、および選択された 1 つのデータセットを含むクリーンな `dist/pages/` ディレクトリを作成します。すべての検索動作はブラウザ内で実行されるため、Pages のターゲットは、Vinext サーバーのエントリ ポイントを必要とするのではなく、静的な Vite/React アプリケーションである必要があります。

次の場合、アセンブリ手順は失敗します。

- 出力には複数の辞書の版が存在します。
- マニフェストが不足しているファイルを参照しています。
- 生成されたファイルは、設定されたファイルごとの予算を超えます。
- 合計ファイル数が、設定されたページの予算を超えています。
- 要求されたコアまたはフル アーティファクトは利用できないか、チェックサムが間違っています。

アップロードする前に、この正確なディレクトリをローカルで提供します。

```sh
npm run build:pages -- --edition sample
npm run preview:pages
```

開発サーバーを介したテストだけでは、運用エントリ ポイント、コピーされたアセット、または `_headers` の配置を証明できないため不十分です。

## 推奨される最初の展開

Wrangler でデプロイされた Cloudflare Pages **直接アップロード** プロジェクトを使用します。これは、選択した完全なワークフローと一致します。ローカル マシンまたは CI は完全な出力をアセンブルして検証しますが、Pages は完成した静的ファイルのみを受け取ります。

直接アップロード プロジェクトを後で Pages Git 統合に変換することはできません。ブランチ プレビューは Wrangler で明示的にデプロイでき、大規模な辞書のビルドは CI の制御下に残す必要があるため、このトレードオフはここでは許容されます。ネイティブのプルリクエストのプレビューが後で制御されたアセンブリ パイプラインよりも価値があるようになった場合は、運用プロジェクトを変更するのではなく、別の Git 統合サンプル プロジェクトを作成します。

直接アップロード プロジェクトの名前は `sudachi-lookup` で、実稼働ブランチとして `main` が構成されています。最初のサンプル デプロイメントは、<https://staging.sudachi-lookup.pages.dev> の `staging` プレビュー エイリアスで利用できます。

決定的な静的出力が存在したら、対話的にプロジェクトを作成します。

```sh
npx wrangler login
npx wrangler pages project create
```

優先プロジェクト名として `sudachi-lookup` を使用し、運用ブランチとして `main` を使用します。次に、最初のアップロードを非実稼働サンプル プレビューにします。

```sh
npm run build:pages -- --edition sample
npx wrangler pages deploy dist/pages \
  --project-name=sudachi-lookup \
  --branch=staging
```

後続のサンプル プレビューでは、次の順序でリポジトリ パッケージが作成されます。

```sh
npm run deploy:pages:staging
```

Core は別のプレビュー ブランチとエディション固有のコマンドを使用します。

```sh
npm run deploy:pages:core-staging
```

このコマンドは、準備されたコア アーティファクトを検証し、サンプルまたは完全なデータなしでコアをアセンブルし、固定された SudachiDict ライセンスと法的通知を含めて、`core-staging.sudachi-lookup.pages.dev` にデプロイします。

プレビューは、以下を確認した後にのみ受け入れてください。

- アプリケーションはロードされ、ページの直接リロード後も存続します。
- `今日` および代表的な曲面、読み取り、正規化形式の検索が機能します。
- 構造コンポーネントと拡張された A/B/C ユニットは引き続きナビゲート可能です。
- 日本語 IME 構成では、破壊的な検索は発生しません。
- 古い W​​eb ワーカーの応答は、新しいクエリを置き換えることはできません。
- 欠落したシャードは、後続の検索を中断することなく、目に見えて失敗します。
- 辞書ファイルには、予期されたコンテンツ タイプと圧縮が含まれています。
- HTML とマニフェストは再検証されますが、バージョン管理されたシャードは不変のままです。

Cloudflareは、現在のダイレクトアップロードコマンドとプレビューブランチURLの動作を[ダイレクトアップロード](https://developers.cloudflare.com/pages/get-started/direct-upload/)に文書化しています。

## 段階的辞書ロールアウト

最初の実データ展開を「完全」にしないでください。次の進行を使用します。

1. **サンプル プレビュー:** ルーティング、静的出力、MIME タイプ、キャッシュ、および Pages プロジェクト構成を証明します。
2. **コア プレビュー:** `core-staging` などの別のブランチにデプロイし、実際の転送、検索レイテンシー、リクエスト数、ブラウザー メモリを測定します。
3. **自動コア リリース:** CI 所有のアセンブリを追加し、デプロイに使用される正確な辞書アーティファクトと出力メタデータを保持します。
4. **完全なプレビュー:** 明示的なリリースまたは手動 CI ジョブを通じてのみ完全をデプロイし、モバイル キャッシュとコールド キャッシュでコア測定を繰り返します。
5. **実稼働リリース:** 実稼働デプロイ中にデータを再生成するのではなく、以前に検証されたアーティファクトをプロモートします。

通常のフロントエンド チェックとプレビューでは、引き続きサンプル フィクスチャが使用されます。コアとフルは明示的に選択されます。アプリケーションのローカルのフルからコアからサンプルへのフォールバックをデプロイメント選択ロジックとして使用してはなりません。

明示的な手動の完全プレビュー コマンドは、固定された v10 データを検証し、完全のみを含む出力を構築し、それを `full-staging` ブランチにデプロイします。

```sh
npm run deploy:pages:full-staging
```

安定したプレビュー エイリアスは <https://full-staging.sudachi-lookup.pages.dev> です。コアは、比較やロールバックのために独自のプレビュー エイリアスで引き続き利用できます。

## 静的キャッシュ ポリシー

現在の `_headers` ファイルは、サンプル フィクスチャを再検証可能に保ち、フィンガープリントされたアプリケーション アセットとバージョン管理されたコア パスまたはフル パスに不変のキャッシュを適用します。

コンテンツアドレス指定またはリリースバージョン指定のシャードでは、以下を使用できます。

```text
Cache-Control: public, max-age=31556952, immutable
```

HTML エントリ ポイントと、アクティブなリリースを選択する小さなマニフェストは、再検証可能である必要があります。これにより、古いマニフェストと不足している新しいシャードが混在することなく、リリースは新しいバージョンのディレクトリに自動的に切り替えることができます。 Cloudflareは、[ヘッダー](https://developers.cloudflare.com/pages/configuration/headers/)で静的アセットルールを説明し、[サービス提供ページ](https://developers.cloudflare.com/pages/configuration/serving-pages/)でデフォルトの圧縮とキャッシュの動作を説明します。

## カスタム ドメインに接続する場合

運用ドメインを予約するためだけに接続しないでください。リリース候補が次のすべてを満たす場合に接続します。

- 辞書の整合性と検索フィクスチャは合格です。
- 表示されている辞書の版数とバージョンは正しいです。
- ライセンスと帰属に関する通知が公開されます。
- キャッシュの無効化はバージョン変更全体で実行されました。
- モバイルおよびコールド キャッシュのパフォーマンスは、合意された予算を満たしています。
- キーボード、IME、アクセシビリティのテストが完了しました。
- リリースは、以前に保持されていたアーティファクトにロールバックできます。

安定したパブリック テスト アドレスが役立つ場合は、運用サブドメインに接続する前に、ステージング サブドメインをプレビュー ブランチにアタッチします。

DNS を手動で作成または変更する前に、**Workers & Pages → Pages プロジェクト → カスタム ドメイン** を通じてホスト名を追加します。最初の公開リリースにはサブドメインを推奨します。 DNSゾーンがすでにCloudflareによって管理されている場合、Pagesは必要なレコードを作成できます。それ以外の場合は、ホスト名を Pages プロジェクトに関連付けた後、割り当てられた `pages.dev` ホスト名を CNAME で指定します。 [カスタム ドメイン](https://developers.cloudflare.com/pages/configuration/custom-domains/) を参照してください。

## 展開の代替案

### 準備済みアーティファクトを使うPages管理のビルド

```text
Git push
    -> Pages build
    -> download prepared dictionary archive
    -> build frontend and unpack data
    -> publish
```

これにより、最もシンプルなネイティブの Pages プレビュー エクスペリエンスが維持されます。アーティファクトのダウンロードと解凍が高速なままであれば、コア プロトタイプに適している可能性があります。

フルではデメリットがより顕著になります。関連するすべての Pages ビルドでアーティファクトのダウンロードとアセンブリが繰り返され、ビルドはアーティファクト ホストに依存し、作業は Pages ビルド環境内で完了する必要があります。

### CI 所有のビルドと Wrangler デプロイメント

```text
Git push or release tag
    -> CI retrieves validated dictionary artifact
    -> CI builds and tests complete dist/
    -> CI uploads dist/ to Pages with Wrangler
```

これは推奨される完全なワークフローです。 CI は正確な製造アセンブリを所有します。 Pages は、結果の静的ファイルのみをホストします。

利点は次のとおりです。

- キャッシュされたデータとビルド間の中間作業
- アップロード前の明示的な検証
- 辞書とジェネレーターの正確なバージョンに関連付けられたリリース タグ
- 実際にデプロイされたアーティファクトの保持
- Pages 環境では高価な辞書変換は不要
- 小規模かつ高速なフロントエンドのみのプル リクエスト

トレードオフは、追加のワークフロー コード、CI での Cloudflare デプロイメント認証情報、およびブランチ プレビューの明示的な構成です。

## 推奨される CI 分離

### Dictionary リリース ワークフロー

固定された SudachiDict のバージョン、エディション、またはジェネレーターが変更されたときにトリガーされます。

```text
download and verify upstream input
    -> generate shards
    -> run integrity and search fixtures
    -> record performance and size report
    -> package checksums and notices
    -> publish immutable versioned artifact
```

アーティファクト ID には少なくとも以下を含める必要があります。

- 辞書の版とバージョン
- データフォーマットバージョン
- ジェネレーターのバージョンまたはコミット
- コンテンツのチェックサム

### Site 導入ワークフロー

リリース候補、製品リリース、または明示的に要求されたプレビューのトリガー。

```text
build frontend
    -> retrieve selected dictionary artifact
    -> assemble dist/
    -> verify manifest and every referenced file
    -> enforce file-count and file-size budgets
    -> smoke-test static output
    -> deploy with Wrangler
```

通常のフロントエンド プル リクエストは、サンプル フィクスチャに対してビルドする必要があります。 Full は、明示的なステージング ジョブと実稼働ジョブにのみ付加する必要があります。

リポジトリには、2 つの GitHub Actions ワークフローが含まれています。

- `Check` は、プッシュおよびプル リクエストでサンプル ジェネレーター、テスト、型チェック、アプリケーション ビルド、およびサンプル ページ アセンブリを実行します。
- `Deploy Full production` は手動であり、固定された公式パッケージから完全を派生し、一時的なアクション アーティファクトとしてリリース レポートのみをアップロードし、検証された静的ディレクトリをページ `main` ブランチにデプロイします。

`production` という名前の保護された GitHub 環境を構成します。必要に応じて承認ルールを追加し、`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を環境シークレットとして保存します。トークンのスコープを **アカウント → Cloudflare Pages → 編集** および目的のアカウントに設定します。 Wrangler ログイン、生成された辞書、ニュートラル エクスポート、またはページ出力を Git に保存しないでください。ワークフローは、クリーンな `dist/pages/` ディレクトリのみを Wrangler に渡します。 Cloudflareの現在の設定は、[継続的統合で直接アップロードを使用する](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)に記載されています。

## Edition ポリシー

Core は、依然として有用な低コストのプレビューおよび検証のターゲットです。パブリック実稼働ワークフローでは、明示的に「完全」を選択します。ワークスペースに残された無視されたファイルからエディションを推測することはありません。

完全版を公開する前に、次のことを記録してください。

- 圧縮サイズと非圧縮サイズ
- 静的ファイルの数
- 最大の資産サイズ
- コールド検索とウォーム検索のレイテンシ
- ワーカーのピーク時の記憶力
- CI の生成とアセンブリにかかる時間
- 保持とロールバックのコスト

フル v10 プレビュー候補は、次のアセンブリ ベースラインを確立します。

|測定 |完全な 20260428 v10 |
| --- | ---: |
|検索可能なエントリ | 2,452,463 |
|エイリアスの検索 | 12,257,080 |
| POS値 | 1,558 |
|圧縮POSテーブル | 10,587 B |
|ブートストラップキー | 4,142 |
|ブートストラップ転送 | 891,484 B |
|構造一致シャード | 128 |
|構造一致転送 | 8,875,874 B |
|ページアーティファクト | 643.9 MiB |
|ページファイル | 4,000 |
|最大のファイル | 870.6 KiB |

コールドおよびウォーム レイテンシー、ピーク ワーカー メモリ、およびモバイル ネットワークの動作は、アセンブリのプロパティではなく展開の測定値です。 Full を Core に置き換えるべきか、それとも別の選択可能なエディションにするかを選択する前に、これらを Full プレビューと比較して記録してください。

Full がホスティング、転送、メモリの予算内で問題なく収まる場合は、Core に取って代わるか、選択可能なエディションになる可能性があります。製品の決定は、測定に先立つのではなく、測定に続いて行う必要があります。
