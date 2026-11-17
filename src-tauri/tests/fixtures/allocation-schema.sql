CREATE TABLE mc_channel_allocated_audit (id BIGINT PRIMARY KEY);
CREATE TABLE mc_goods (id BIGINT PRIMARY KEY, sku VARCHAR(32));
CREATE TABLE mc_spu (id BIGINT PRIMARY KEY, code VARCHAR(32));
CREATE TABLE mc_items (id BIGINT PRIMARY KEY, items_code VARCHAR(32), spu_id BIGINT, KEY(items_code));
CREATE TABLE mc_vsku (id BIGINT PRIMARY KEY, vsku VARCHAR(32), items_id BIGINT, KEY(items_id));
CREATE TABLE mc_vsku_mapping_sku (goods_id BIGINT, vsku_id BIGINT, KEY(goods_id), KEY(vsku_id, goods_id));
CREATE TABLE mc_platform_config (id BIGINT PRIMARY KEY, name VARCHAR(32));
CREATE TABLE mc_channel_allocated_record (
    id BIGINT PRIMARY KEY, allocated_audit_id BIGINT, goods_id BIGINT,
    order_id VARCHAR(32), transfer_type INT, source_id BIGINT, target_id BIGINT,
    allocate_time DATETIME, number INT, allocate_state INT, is_del INT,
    KEY lookup_goods (goods_id, allocate_state, is_del, allocate_time)
);
INSERT INTO mc_platform_config VALUES (1, '调出测试渠道'), (2, '调入测试渠道');
INSERT INTO mc_spu VALUES (1, 'SPU-DEMO');
SET SESSION cte_max_recursion_depth = 100000;
INSERT INTO mc_goods WITH RECURSIVE seq AS (SELECT 1 n UNION ALL SELECT n+1 FROM seq WHERE n<1000)
SELECT n, CONCAT('SKU-',n) FROM seq;
INSERT INTO mc_items SELECT id, IF(id=1, 'G30058-1212GR', CONCAT('OTHER-',id)), 1 FROM mc_goods;
INSERT INTO mc_vsku SELECT id, CONCAT('VSKU-',id), id FROM mc_goods;
INSERT INTO mc_vsku_mapping_sku SELECT id, id FROM mc_goods;
INSERT INTO mc_channel_allocated_audit VALUES (1);
INSERT INTO mc_channel_allocated_record
WITH RECURSIVE seq AS (SELECT 1 n UNION ALL SELECT n+1 FROM seq WHERE n<100000)
SELECT n, 1, IF(n<=31, 1, MOD(n,999)+2), CONCAT('ORDER-',n), 2, 1, 2, '2026-09-10 12:00:00', 1, 2, 0 FROM seq;
