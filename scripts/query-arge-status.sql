SELECT d.sn, d.unit_no, d.label, ls.last_seen_at, ls.switch_state, ls.balance
FROM devices d
JOIN customers c ON c.id = d.customer_id
LEFT JOIN device_latest_state ls ON ls.sn = d.sn
WHERE c.name = 'Arge'
ORDER BY d.sn;
