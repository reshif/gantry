-- Gates a person must decide (merge review G5, G2, G3d, brief G0G1, and plan and security G3G3s beyond checks-then-person) may never be automatic.
-- Earlier releases only blocked new edits; this resets rows already stored. The engine also ignores such modes at runtime (gateKind).
update gate_modes set mode = 'human', updated_at = now()
 where (gate_id in ('G5', 'G2', 'G3d', 'G0G1') and mode <> 'human')
    or (gate_id = 'G3G3s' and mode = 'auto');
