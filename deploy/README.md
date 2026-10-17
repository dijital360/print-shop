# Print Shop'u VPS üzerinde yayımlama

Bu kılavuz gerçek sipariş, dosya ve prova akışını VPS'te yayımlamak içindir. Mevcut
`docker-compose.yml` ayrı Adminium/demo kurulumu içindir; burada
`compose.shop.yml` kullanılır. Hedef sunucu henüz seçilmedi; bu dosyaların
hazırlanması uygulamanın internette yayımlandığı anlamına gelmez.

## 1. Sunucuyu ve alan adını hazırlayın

VPS üzerinde Docker, Docker Compose v2 ve Node.js 22.18+ bulunmalı. Depoyu
sunucuya alın ve aşağıdaki komutları depo dizininde çalıştırın. Alan adınızın
DNS A kaydını VPS IP adresine yönlendirin; IPv6 kullanıyorsanız AAAA kaydını da
doğru sunucuya yönlendirin. Sunucuda 80 ve 443 numaralı portlar açık olmalı.

Yerel geliştirme ortamında yayın öncesi kontroller:

```sh
npm ci
npx tsc -b
npm test
npm run build:shop
```

## 2. Yayın ayarlarını oluşturun

`baski.example.com` yerine kendi alan adınızı, `https://` eklemeden yazın:

```sh
node scripts/configure-production.mjs baski.example.com
```

Bu komut `.env.production` dosyasını yalnız dosya sahibinin okuyup yazabileceği
şekilde oluşturur ve veritabanı için rastgele parola üretir. Mevcut dosyayı
ezmez. Bu dosyayı veya parolaları Git'e, sohbetlere ya da paylaşılan loglara
koymayın; sonraki güncellemelerde aynı dosyayı koruyun.

## 3. Önce yönetici hesabını, sonra siteyi açın

Önce yalnız veritabanını ve sipariş servisini başlatın. Bu aşamada internete
uygulama portu açılmaz:

```sh
docker compose --env-file .env.production -f compose.shop.yml up -d db api --build
docker compose --env-file .env.production -f compose.shop.yml run --rm -it api node server/cli.ts owner@example.com
```

İkinci komutta kendi e-posta adresinizi kullanın ve personel parolanızı özel
istemden girin. Hesap oluşturulduktan sonra siteyi açın:

```sh
docker compose --env-file .env.production -f compose.shop.yml up -d web --build
```

Caddy alan adınız için HTTPS sertifikasını otomatik alır. Müşteriler
`https://baski.example.com` adresini, personel ise
`https://baski.example.com/staff` adresini kullanır. Veritabanı ve API portları
internete yayımlanmaz; `/api/shop` aynı alan adı üzerinden çalışır.

Sağlık kontrolü `https://baski.example.com/api/shop/health` adresidir. Yayını
tamamlanmış saymadan önce personel girişi, müşteri siparişi, dosya yükleme,
prova onayı ve servis yeniden başlatıldıktan sonra kayıtların korunmasını hedef
sunucuda doğrulayın. Örnek fiyatları gerçek tarifeyle karşılaştırın; bu sürüm
ödeme almadan sipariş kaydeder.

## 4. Verileri yedekleyin

Siparişler ve orijinal/prova dosyaları PostgreSQL'in kalıcı Docker volume'ünde
tutulur. Düzenli yedek alın ve kopyasını sunucu dışında güvenli yerde saklayın.
Aşağıdaki komut, depo dışında yalnız operatörün erişebildiği bir klasöre
veritabanının custom-format yedeğini yazar:

```sh
umask 077
mkdir -p ../print-shop-backups
chmod 700 ../print-shop-backups
docker compose --env-file .env.production -f compose.shop.yml exec -T db pg_dump -U print_shop -d print_shop -Fc > "../print-shop-backups/print-shop-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Yetkili operatör yedeği ayrı, boş bir test veritabanına geri yükleyerek
doğrulamalıdır. Aşağıdaki örnek canlı veritabanı yerine
`print_shop_restore_check` oluşturur; `YEDEK.dump` yerine alınan yedeğin adını
yazın:

```sh
docker compose --env-file .env.production -f compose.shop.yml exec -T db createdb -U print_shop print_shop_restore_check
docker compose --env-file .env.production -f compose.shop.yml exec -T db pg_restore -U print_shop -d print_shop_restore_check --exit-on-error < ../print-shop-backups/YEDEK.dump
```

`docker compose down -v` kalıcı veritabanı volume'ünü ve verileri siler;
güncelleme veya normal durdurma için kullanmayın.

Güncellemelerde `.env.production` dosyasını ve volume'leri koruyarak yeni kodla
şu komutu çalıştırın:

```sh
docker compose --env-file .env.production -f compose.shop.yml up -d --build
```

VPS yoksa bu paket Docker destekli yönetilen barındırmaya, kalıcı disk veya
yönetilen PostgreSQL ile uyarlanabilir. Bu kılavuz hesap açmaz, ücretli hizmet
satın almaz ve dış platformlarda yayın işlemi yapmaz.
