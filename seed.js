import { migrate, q, uniqueSlug } from './db.js';

const SAMPLES = [
  ['SW-BR-001','Wine Kanjivaram with wide gold zari border','bridal','Pure silk','Wine / gold','Zari',28500,34000,2,3],
  ['SW-BR-002','Ivory Banarasi with hand-worked pallu','bridal','Katan silk','Ivory / gold','Zari, hand work',41000,0,1,2],
  ['SW-PA-001','Black georgette with sequin scatter','party','Georgette','Black / silver','Sequin',7800,9500,4,1],
  ['SW-PA-002','Emerald organza with mirror edging','party','Organza','Emerald','Mirror',9200,0,3,0],
  ['SW-FE-001','Mustard cotton silk with thin zari','festive','Cotton silk','Mustard','Zari',3400,0,8,1],
  ['SW-FE-002','Peacock blue Ilkal, contrast pallu','festive','Cotton','Peacock blue','Woven',2900,3600,6,0],
  ['SW-DE-001','Hand-painted Kalamkari, one piece only','designer','Cotton silk','Rust / indigo','Hand painted',15500,0,1,3],
  ['SW-BL-001','Maroon aari-work blouse, size 38','blouse','Raw silk','Maroon','Aari',2400,2900,3,1],
  ['SW-BL-002','Gold zardozi blouse, size 40','blouse','Brocade','Gold','Zardozi',3200,0,2,0]
];

const BLURB = {
  bridal: 'Bought from the weaver directly. Blouse stitched to your measurements.',
  party: 'Sits comfortably through a long evening and photographs well under warm light.',
  festive: 'Light enough for a full day of pooja and lunch, and it takes a wash.',
  designer: 'A single piece. We do not repeat a design within the season.',
  blouse: 'Ready to wear off the rail. Alterations in-house, two to three days.'
};

await migrate();

for (const [sku, title, coll, fabric, colour, work, price, mrp, stock, boost] of SAMPLES) {
  const exists = await q('SELECT 1 FROM products WHERE sku = @sku', { sku });
  if (exists.length) continue;
  await q(`INSERT INTO products (sku, slug, title, collection, fabric, colour, work,
             description, price, mrp, stock, boost, images, active)
           VALUES (@sku,@slug,@title,@coll,@fabric,@colour,@work,
                   @desc,@price,@mrp,@stock,@boost,'[]',1)`,
    { sku, slug: await uniqueSlug(title), title, coll, fabric, colour, work,
      desc: BLURB[coll], price, mrp, stock, boost });
}

const [{ n }] = await q('SELECT COUNT(*) AS n FROM products');
console.log(`Seeded. Catalogue has ${n} pieces. Photos are empty — upload them from /admin.`);
process.exit(0);
