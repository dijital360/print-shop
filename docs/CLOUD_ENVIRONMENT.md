# Codex bulut ortamı kurulum notları

Bu dosya geliştirme ortamını yeniden hazırlamak içindir. Depoya yazılması,
Codex ortam ayarlarındaki `install_script` ve `start_skill` alanlarını otomatik
değiştirmez. Railway'deki uygulama yayını da bu ayarlardan ayrı çalışır.

## Ortam ayarlarında saklanacak bilgiler

Çalışma zamanı olarak **Node.js 24** kullanın; bağımlılıklar `package-lock.json`
ile sabittir. `install_script` için temel kurulum:

```sh
#!/usr/bin/env bash
set -euo pipefail
cd /workspace/print-shop
node --version
npm ci --cache /workspace/.npm-cache --no-audit --no-fund
```

`start_skill` içinde şu çalışma kurallarını koruyun:

- Mevcut `/workspace/print-shop` checkout'unu kullan; önce `git status` kontrol
  et ve mevcut değişiklikleri koru. Her bulut görevi zaten yalıtılmıştır;
  kullanıcı istemedikçe Git worktree oluşturma.
- Standart geliştirme akışı `npm run dev:shop` komutudur. API'yi
  `127.0.0.1:4100` üzerinde başlatır, hazır olmasını bekler, ardından Vite'ı
  `0.0.0.0:5173` üzerinde canlı sipariş modunda açar. Bu komut için API portunu
  4100 olarak bırak; Adminium kurulumu gerekmez.
- Hazırlık kontrolünde `/api/shop/health` 200 ve `{"ok":true}` döndürmeli;
  müşteri bootstrap isteği `/api/shop/bootstrap?side=customer` yalnız kendi
  kapsamındaki veriyi döndürmeli. Oturumsuz personel bootstrap isteği
  `/api/shop/bootstrap?side=staff` 401, `/staff` sayfası 200 döndürmeli.
  Kontrolleri Vite'ın 5173 portu üzerinden yap; oturum çerezlerini yazdırma.
- Yerel PostgreSQL/PGlite verileri Git'in görmezden geldiği
  `.print-shop.local/database` içinde kalıcıdır. Bu veritabanını aynı anda tek
  süreç açabilir. Personel hesabı için `npm run shop:staff -- <kendi-e-posta>`
  çalıştırmadan önce API'yi durdur. Parola özel istemden girilir; rutin açılışta
  hesap oluşturma veya parola sıfırlama yapma.
- Süreçler yeni göreve taşınmaz; her görevde geliştirme sunucusunu yeniden
  başlat. Ortam görüntüsü alınmadan önce başlattığın süreçleri düzgün kapat;
  sahibi bilinmeyen veritabanı kilitlerini silme.

Doğrulama komutları:

```sh
npx tsc -b
npm test -- --maxWorkers=3 --minWorkers=1
npm run build:shop
npm run build
```

## Eski ortam taslağı güncellenemiyorsa

Mevcut ortam ayarlarından yeni bir kurulum sohbeti başlatın. O sohbette
`cloud-environment-onboarding:setup` ile **güncel taslağın okunmasını**, bu
notlarla karşılaştırılmasını ve mevcut ayarlar korunarak güncellenmesini
isteyin. Sonrasında ortam ayarlarında yeni taslağı gözden geçirip kaydedin.
Eski taslağın güncellenememesi depo dosyası değiştirerek giderilemez.

Bu oturumun ek taşıma bilgileri `/workspace/print-shop-setup-handoff.json`
dosyasındadır; dosya ortam ayarlarının yerine geçmez. Aktarım dosyasını indirip
yeni sohbete ekleyin; yeni sohbetin aynı çalışma alanını devralacağını
varsaymayın. Kimlik doğrulama bilgileri bu belgelere veya kurulum betiklerine
konulmamalıdır.

## Railway yayını ve CLI

Canlı adres: <https://print-shop-production-2bf0.up.railway.app>. 17 Ekim 2026'da
HTTPS sağlık kontrolü, site ve statik dosyalar, müşteri oturumu ve personel
erişim sınırı doğrulandı. Yayın kaynağı `codex/persistent-shop-orders` dalı ve
`Dockerfile.railway` dosyasıdır; ayrıntılar [Railway rehberinde](../deploy/RAILWAY.md).
Ortamı kaydetmek yeni bir Railway yayını başlatmaz.

Bu bulut ortamında doğrulanmış CLI, Railway **5.70.0** sürümüdür:
`/workspace/.tools/railway-5.70.0/railway`. Yeniden kurulum gerekirse resmî
[Linux x86_64 musl arşivini](https://github.com/railwayapp/cli/releases/download/v5.70.0/railway-v5.70.0-x86_64-unknown-linux-musl.tar.gz)
indirin ve açmadan önce SHA-256 değerini doğrulayın:

```text
f518230646acc7a6a7a67365e7642618f659d5d8cdd7cf8c180336140d0504eb
```

CLI oturumu özel çalışma zamanı bilgisidir; yeni görevde geçerli olduğunu
varsaymayın. Önce `railway whoami` kontrolü yapın, özel kimlik dosyasını okumayın.
Bulut ortamının dosya sistemi görüntüsü yayımlanmadan önce `railway logout`
ile çıkış yapın; kimlik bilgilerini görüntüye taşımayın.
