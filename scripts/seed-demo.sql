-- Finch demo dataset — safe to run against an isolated MySQL instance.
DROP DATABASE IF EXISTS finch_demo;
CREATE DATABASE finch_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE finch_demo;

SET SESSION cte_max_recursion_depth = 10000;

CREATE TABLE customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  email VARCHAR(160) NOT NULL,
  country CHAR(2) NOT NULL,
  city VARCHAR(80) NOT NULL,
  tier ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  lifetime_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_customers_email (email),
  KEY idx_customers_country (country),
  KEY idx_customers_tier (tier)
) ENGINE=InnoDB COMMENT='Customer accounts across all channels';

CREATE TABLE products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(40) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  cost DECIMAL(10,2) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_products_sku (sku),
  KEY idx_products_category (category),
  KEY idx_products_active (active)
) ENGINE=InnoDB COMMENT='Sellable catalog with margin data';

CREATE TABLE orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no VARCHAR(24) NOT NULL,
  customer_id INT UNSIGNED NOT NULL,
  status ENUM('pending','paid','packed','shipped','delivered','refunded','cancelled') NOT NULL,
  channel ENUM('web','ios','android','retail') NOT NULL,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax DECIMAL(12,2) NOT NULL DEFAULT 0,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  placed_at DATETIME NOT NULL,
  shipped_at DATETIME NULL,
  notes VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_orders_order_no (order_no),
  KEY idx_orders_customer (customer_id),
  KEY idx_orders_status_placed (status, placed_at),
  KEY idx_orders_placed (placed_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB COMMENT='Commerce orders, all channels';

CREATE TABLE order_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  discount DECIMAL(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_items_order (order_id),
  KEY idx_items_product (product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB COMMENT='Line items for each order';

CREATE TABLE inventory_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT UNSIGNED NOT NULL,
  warehouse CHAR(8) NOT NULL,
  delta INT NOT NULL,
  reason ENUM('restock','sale','return','adjustment','damage') NOT NULL,
  reference VARCHAR(40) NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_inventory_product_time (product_id, created_at),
  CONSTRAINT fk_inventory_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE=InnoDB COMMENT='Append-only inventory ledger';

CREATE TABLE support_tickets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  subject VARCHAR(180) NOT NULL,
  priority ENUM('low','normal','high','urgent') NOT NULL,
  status ENUM('open','pending','resolved','closed') NOT NULL,
  assignee VARCHAR(60) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY idx_tickets_status (status, updated_at),
  CONSTRAINT fk_tickets_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE=InnoDB COMMENT='Support queue with SLA state';

CREATE TABLE daily_metrics (
  metric_date DATE NOT NULL,
  visits INT NOT NULL,
  signups INT NOT NULL,
  orders_count INT NOT NULL,
  revenue DECIMAL(12,2) NOT NULL,
  refunds DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (metric_date)
) ENGINE=InnoDB COMMENT='Daily commerce rollup';

INSERT INTO customers (name, email, country, city, tier, lifetime_value, created_at, notes)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 220)
SELECT
  ELT(1 + MOD(i * 7, 24),
      'Maya Chen','Noah Patel','Iris Laurent','Sora Tanaka','Leo Martins','Amelia Brooks',
      'Ethan Kim','Sofia Rossi','Lucas Meyer','Ava Nguyen','Oliver Smith','Emilia Novak',
      'Hiro Sato','Clara Dubois','Mateo Alvarez','Zoe Wilson','Felix Wagner','Nora Haddad',
      'Ravi Sharma','Elena Petrova','Jonas Berg','Aisha Okafor','Daniel Park','Lucia Bianchi'),
  CONCAT(LOWER(REPLACE(ELT(1 + MOD(i * 7, 24), 'Maya Chen','Noah Patel','Iris Laurent','Sora Tanaka','Leo Martins','Amelia Brooks','Ethan Kim','Sofia Rossi','Lucas Meyer','Ava Nguyen','Oliver Smith','Emilia Novak','Hiro Sato','Clara Dubois','Mateo Alvarez','Zoe Wilson','Felix Wagner','Nora Haddad','Ravi Sharma','Elena Petrova','Jonas Berg','Aisha Okafor','Daniel Park','Lucia Bianchi'), ' ', '.')), i, '@example.com'),
  ELT(1 + MOD(i, 10), 'US','GB','DE','FR','JP','SG','CA','AU','BR','NL'),
  ELT(1 + MOD(i * 3, 12), 'San Francisco','London','Berlin','Paris','Tokyo','Singapore','Toronto','Sydney','São Paulo','Amsterdam','New York','Seoul'),
  ELT(1 + MOD(i * 5, 3), 'free','pro','enterprise'),
  ROUND(80 + MOD(i * 937, 24000) / 10, 2),
  DATE_SUB(NOW(), INTERVAL MOD(i * 17, 720) DAY),
  IF(MOD(i, 11) = 0, 'VIP account — prefers email support.', NULL)
FROM n;

INSERT INTO products (sku, name, category, price, cost, stock, active, metadata, created_at)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 72)
SELECT
  CONCAT('SKU-', LPAD(i, 4, '0')),
  CONCAT(ELT(1 + MOD(i, 18),
    'Aero Wireless Headphones','Studio Monitor Stand','Meridian Desk Lamp','Drift Mechanical Keyboard',
    'Pulse Fitness Band','Halo Smart Speaker','Nimbus Laptop Sleeve','Terra Ceramic Mug',
    'Vector USB-C Hub','Lumen Portable Display','Atlas Standing Mat','Cove Noise Machine',
    'Flux Charging Pad','Orbit Webcam','Slate Notebook','Fjord Water Bottle',
    'Sable Cable Kit','Moss Plant Pot'), ' ', ELT(1 + MOD(i * 5, 4), 'Gen 2','Pro','Mini','Edition')),
  ELT(1 + MOD(i, 6), 'Audio','Desk','Lighting','Input','Wearables','Accessories'),
  ROUND(18 + MOD(i * 73, 4200) / 10, 2),
  ROUND((18 + MOD(i * 73, 4200) / 10) * 0.58, 2),
  8 + MOD(i * 37, 240),
  IF(MOD(i, 13) = 0, 0, 1),
  JSON_OBJECT('color', ELT(1 + MOD(i, 5), 'graphite', 'sand', 'sage', 'ink', 'silver'), 'weight_g', 120 + MOD(i * 31, 900), 'warranty_months', IF(MOD(i, 4) = 0, 36, 24)),
  DATE_SUB(NOW(), INTERVAL MOD(i * 23, 500) DAY)
FROM n;

INSERT INTO orders (order_no, customer_id, status, channel, subtotal, tax, total, currency, placed_at, shipped_at, notes)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 1680)
SELECT
  CONCAT('F-', 240000 + i),
  1 + MOD(i * 29, 220),
  ELT(1 + MOD(i * 7, 10), 'pending','paid','paid','packed','shipped','shipped','delivered','delivered','refunded','cancelled'),
  ELT(1 + MOD(i * 11, 4), 'web','ios','android','retail'),
  0, 0, 0, 'USD',
  DATE_SUB(NOW(), INTERVAL MOD(i * 37, 120) DAY) - INTERVAL MOD(i * 13, 1440) MINUTE,
  IF(MOD(i * 7, 10) IN (4,5,6,7), DATE_SUB(NOW(), INTERVAL MOD(i * 37, 110) DAY) + INTERVAL 6 HOUR, NULL),
  IF(MOD(i, 37) = 0, 'Gift wrap requested — include handwritten note.', NULL)
FROM n;

INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 4200)
SELECT
  1 + MOD(i * 17, 1680),
  1 + MOD(i * 31, 72),
  1 + MOD(i, 3),
  p.price,
  IF(MOD(i, 17) = 0, ROUND(p.price * 0.15, 2), 0)
FROM n
JOIN products p ON p.id = 1 + MOD(n.i * 31, 72);

UPDATE orders o
JOIN (
  SELECT order_id,
         SUM(quantity * unit_price - discount) AS subtotal
  FROM order_items
  GROUP BY order_id
) totals ON totals.order_id = o.id
SET o.subtotal = totals.subtotal,
    o.tax = ROUND(totals.subtotal * 0.0825, 2),
    o.total = ROUND(totals.subtotal * 1.0825, 2);

INSERT INTO inventory_events (product_id, warehouse, delta, reason, reference, created_at)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 520)
SELECT
  1 + MOD(i * 13, 72),
  ELT(1 + MOD(i, 4), 'US-EAST','US-WEST','EU-CEN','AP-SG'),
  CASE WHEN MOD(i, 4) = 0 THEN -1 * (1 + MOD(i, 8)) ELSE 10 + MOD(i, 90) END,
  ELT(1 + MOD(i, 5), 'restock','sale','return','adjustment','damage'),
  CONCAT('PO-', 9000 + MOD(i, 300)),
  DATE_SUB(NOW(), INTERVAL MOD(i * 19, 100) DAY)
FROM n;

INSERT INTO support_tickets (customer_id, subject, priority, status, assignee, created_at, updated_at)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 96)
SELECT
  1 + MOD(i * 23, 220),
  ELT(1 + MOD(i * 7, 10),
    'Order has not arrived yet','Need an invoice with VAT number','Wrong color received',
    'How do I reset my device?','Refund status is still pending','Bulk pricing for a team order',
    'Package arrived damaged','Change shipping address','Warranty replacement question','Duplicate charge on card'),
  ELT(1 + MOD(i * 3, 4), 'low','normal','high','urgent'),
  ELT(1 + MOD(i * 5, 4), 'open','pending','resolved','closed'),
  ELT(1 + MOD(i, 5), 'Mina','Theo','Jules','Rae','Sam'),
  DATE_SUB(NOW(), INTERVAL MOD(i * 11, 30) DAY),
  DATE_SUB(NOW(), INTERVAL MOD(i * 5, 12) DAY)
FROM n;

INSERT INTO daily_metrics (metric_date, visits, signups, orders_count, revenue, refunds)
WITH RECURSIVE n AS (SELECT 0 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 89)
SELECT
  DATE_SUB(CURDATE(), INTERVAL i DAY),
  1800 + MOD(i * 419, 2600) + IF(MOD(i, 7) IN (0, 6), -500, 0),
  36 + MOD(i * 17, 74),
  48 + MOD(i * 29, 90),
  ROUND(4200 + MOD(i * 733, 9800) + IF(MOD(i, 7) IN (0, 6), -1200, 0), 2),
  ROUND(80 + MOD(i * 47, 460), 2)
FROM n;

CREATE OR REPLACE VIEW v_order_summary AS
SELECT
  o.id,
  o.order_no,
  o.status,
  o.channel,
  c.name AS customer_name,
  c.country,
  o.total,
  COUNT(i.id) AS line_items,
  o.placed_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.order_no, o.status, o.channel, c.name, c.country, o.total, o.placed_at;

-- Friendly demo login (local only).
CREATE USER IF NOT EXISTS 'finch'@'%' IDENTIFIED BY 'finch_demo';
GRANT ALL PRIVILEGES ON finch_demo.* TO 'finch'@'%';
FLUSH PRIVILEGES;

SELECT 'customers' AS table_name, COUNT(*) AS rows_count FROM customers
UNION ALL SELECT 'products', COUNT(*) FROM products
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_items', COUNT(*) FROM order_items
UNION ALL SELECT 'inventory_events', COUNT(*) FROM inventory_events
UNION ALL SELECT 'support_tickets', COUNT(*) FROM support_tickets
UNION ALL SELECT 'daily_metrics', COUNT(*) FROM daily_metrics;
