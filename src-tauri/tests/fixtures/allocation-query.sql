SELECT ar.id,g.sku as 'SKU',
v.vsku as 'VSKU',
i.items_code as '品编码',
s.`code` as 'SPU',
ar.order_id as '订单号',
CASE ar.transfer_type
    WHEN 1 THEN
        '手动调拨'
    WHEN 2 THEN
        '自动调拨'
    WHEN 3 THEN
        '不齐套调拨'
    WHEN 4 THEN
        '确认订单库存替换'
    WHEN 5 THEN
        '扣减库存替换'
    WHEN 6 THEN
        '扣减库存调拨'
    WHEN 7 THEN
        '手动冗余申领'
    WHEN 8 THEN
        '强制冗余申领'
    ELSE
        '其他'
END as '调拨类型',
p1.`name` as '调拨渠道',
p2.`name` as '调入渠道',
ar.allocate_time as '调拨时间',
ar.number as '调拨数量'
FROM mc_channel_allocated_record as ar
LEFT JOIN mc_channel_allocated_audit as aa ON aa.id = ar.allocated_audit_id
LEFT JOIN mc_goods as g ON g.id = ar.goods_id
LEFT JOIN mc_vsku_mapping_sku as vms ON vms.goods_id = g.id
LEFT JOIN mc_vsku as v ON v.id = vms.vsku_id
LEFT JOIN mc_items as i ON i.id = v.items_id
LEFT JOIN mc_spu as s ON s.id = i.spu_id
LEFT JOIN mc_platform_config as p1 ON p1.id = ar.source_id
LEFT JOIN mc_platform_config as p2 ON p2.id = ar.target_id
WHERE ar.allocate_time >= '2026-09-01 00:00:00'
AND ar.allocate_time <= '2026-09-22 00:00:00'
AND ar.allocate_state = 2
AND ar.transfer_type NOT IN (4, 5)
AND i.items_code = 'G30058-1212GR' AND ar.is_del = 0;
