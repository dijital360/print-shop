# Ürün ve branda fiyat yönetimi

Personel hesabıyla `/staff/catalogue` adresini açın. **Yeni ürün** ile ürün
ekleyebilir; **Düzenle** ile adını, malzemesini, tutarlarını ve hazırlık süresini
değiştirebilirsiniz. Metrekare veya adet bazında hesaplama seçilebilir.
**Ürün satışta** seçimini kapatmak ürünü vitrinden kaldırır; geçmiş siparişler
ve baskı dosyaları korunur. Ürün silme ve geçmiş siparişi yeniden fiyatlama yoktur.

İlk kurulumdaki Branda tarifesi, matbaa sahibinin verdiği tutarlardır:

| Kalem | KDV hariç tutar |
| --- | --- |
| Branda baskı | 150 TL/m² |
| Minimum sipariş | 500 TL |
| Kuşgözü | 5 TL/adet |
| Kenar kaynağı | 20 TL/metre |
| Kenar kıvırma | 20 TL/metre |
| KDV | %20 |

Müşteri en ve boyu **santimetre**, miktarı adet olarak girer. Baskı alanı
`en × boy / 10.000 × adet` m²'dir. Kuşgözü sayısı **her bir baskı için** girilir;
ücret toplam adede göre çarpılır. Kaynak ve kıvırma bağımsızdır; seçilen her
işlem `2 × (en + boy) / 100 × adet` metre tam çevreye uygulanır.

Baskı ve işçilik toplamı minimumun altındaysa fark sepete bir kez eklenir.
Ardından %20 KDV hesaplanır: 200 × 300 cm tek branda, işçiliksiz 900 TL +
180 TL KDV = **1.080 TL**; minimuma takılan sipariş ise **600 TL** olur.
Birden fazla ürünün bulunduğu sepette en yüksek ürün minimumu bir kez uygulanır.
Farklı KDV politikalarına sahip ürünler ayrı sipariş verilmelidir.

Fiyat, sipariş kaydedilirken sunucudaki ürün sürümünden yeniden hesaplanır.
Ürün tutarı değişirse müşteri güncel fiyatı yüklemelidir. Kaydedilmiş siparişin
adı, ölçüsü, işçilikleri ve tutarı sonradan tarife düzenlense de değişmez.
Siparişten sonra **Dosya yükle ve takip et** bağlantısı mevcut dosya, prova ve
üretim akışını açar. Bu sürüm sipariş kaydeder; çevrimiçi ödeme tahsil etmez.
