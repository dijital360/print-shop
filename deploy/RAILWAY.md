# Sunucu olmadan Railway üzerinde yayımlama

Bu yol için ayrı VPS veya alan adı gerekmez; Railway bir HTTPS adresi sağlar.
Aşağıdaki adımlar yayın hazırlığıdır; Railway hesabında henüz uygulama
yayımlanmadı. Güncel ücret ve deneme koşullarını Railway üzerinde kontrol edin.

## 1. Railway hesabınızı açın

[railway.com](https://railway.com) üzerinden kendi hesabınızı oluşturun ve
GitHub hesabınızı bağlayın. GitHub bağlantısının `dijital360/print-shop`
deposuna erişebildiğini doğrulayın. Hesap ve ücretlendirme onayları size aittir.

## 2. Projeye PostgreSQL ekleyin

Bir proje oluşturun ve PostgreSQL servisi ekleyin. Veritabanı servisi kalıcı
verileri tutar: siparişler, oturumlar, baskı dosyaları ve provalar burada
saklanır. Veritabanının yedekleme seçeneklerini de hesabınızda kontrol edin.

## 3. GitHub deposundan uygulama servisi ekleyin

Aynı projede GitHub deposundan bir uygulama servisi oluşturun. Kaynak depoyu
`dijital360/print-shop`, dalı **`codex/persistent-shop-orders`** olarak seçin;
bu yayın akışı henüz `main` dalında değildir.

Uygulamanın Variables alanına şu değeri ekleyin:

```text
RAILWAY_DOCKERFILE_PATH=Dockerfile.shop
```

Özel başlangıç komutu gerekmez; imaj hem siteyi hem sipariş servisini
çalıştırır. Uygulamayı tek kopya/replica olarak tutun.

## 4. Veritabanını bağlayıp ilk personel hesabını tanımlayın

Uygulama servisinin Variables alanına şu üç değişkeni ekleyin:

| Değişken | Değer |
|---|---|
| `DATABASE_URL` | PostgreSQL servisinin `DATABASE_URL` değişkenine referans |
| `PRINT_SHOP_INITIAL_STAFF_EMAIL` | Kendi personel e-posta adresiniz |
| `PRINT_SHOP_INITIAL_STAFF_PASSWORD` | En az 12 karakterli, güçlü ve size özel parola |

PostgreSQL servisinin adı `Postgres` ise veritabanı referansı şöyledir:

```text
${{Postgres.DATABASE_URL}}
```

Servisin adı farklıysa referansta onun adını kullanın. Parolayı yalnız Railway
Variables alanına özel olarak girin; sohbete, Git'e veya paylaşılan ekran
görüntülerine koymayın. Başlangıç ayarları mevcut personel hesabının parolasını
değiştirmez.

## 5. Genel adres oluşturup yayımlayın

Uygulamanın Networking alanında Railway'in herkese açık alan adını oluşturun.
Hedef port **8080** olmalı; `PORT` için özel bir değer kullanıyorsanız hedef
portu onunla eşleştirin. HTTPS bağlantısını Railway sağlar.

Uygulama genel adresini `RAILWAY_PUBLIC_DOMAIN` üzerinden otomatik kullanır;
normal kurulumda `PRINT_SHOP_PUBLIC_ORIGIN` eklemeniz gerekmez. Özel alan adı
kullanırsanız `PRINT_SHOP_PUBLIC_ORIGIN` değerini onun tam HTTPS adresiyle
ayarlayabilirsiniz; örneğin `https://baski.example.com`.

Ayarları kaydedip deploy işlemini başlatın veya ilk otomatik deneme ayarlar
tamamlanmadan başladıysa yeniden deploy edin. Uygulamanın hazır olduğunu
Railway üzerinden doğrulayın.

## 6. Siteyi ve personel girişini kontrol edin

Railway'in verdiği adres müşterinin sitesidir; adresin sonuna `/staff`
ekleyerek personel girişini açın. Dördüncü adımda girdiğiniz e-posta ve parolayla
giriş yapın. Sağlık kontrolü aynı adresteki `/api/shop/health` yoludur.

İlk başarılı girişten sonra `PRINT_SHOP_INITIAL_STAFF_EMAIL` ve
`PRINT_SHOP_INITIAL_STAFF_PASSWORD` değişkenlerini kaldırıp yeniden deploy
edebilirsiniz; hesap PostgreSQL'de kalır. Bir deneme siparişi, baskı dosyası ve
prova ekleyip yeniden deploy sonrasında kayıtların korunduğunu kontrol edin.

Bu sürüm ödeme almadan sipariş kaydeder; otomatik baskıya hazır dosya kontrolü
ve virüs taraması henüz yoktur. Gerçek sipariş almadan önce örnek fiyatları
kendi tarifenizle karşılaştırın.
