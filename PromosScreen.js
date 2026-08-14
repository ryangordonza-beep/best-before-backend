import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Image,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth, apiGet, API_BASE_URL } from '../api';

const SCREEN_WIDTH = Dimensions.get('window').width;

function formatDate(dateStr) {
  // SQLite datetime('now') -> 'YYYY-MM-DD HH:MM:SS' (no 'T'/'Z'), which
  // Safari/JSC's Date parser handles inconsistently — normalise first.
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
}

export default function PromosScreen() {
  const { token } = useAuth();
  const [promos, setPromos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiGet('/promos', token);
      setPromos(data.promos);
    } catch (e) {
      // Non-critical screen — fail quietly rather than blocking the app
    } finally {
      setLoading(false);
    }
  }, [token]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1b7a3d" />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.container}
      data={promos}
      keyExtractor={(item) => String(item.id)}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      ListHeaderComponent={<Text style={styles.title}>Promotions</Text>}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No promotions right now — check back soon!</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Image
            source={{
              uri: `${API_BASE_URL}/promos/${item.id}/image`,
              headers: { Authorization: `Bearer ${token}` },
            }}
            style={styles.image}
            resizeMode="contain"
          />
          <View style={styles.cardBody}>
            <Text style={styles.cardTitle}>{item.title}</Text>
            {item.caption ? <Text style={styles.cardCaption}>{item.caption}</Text> : null}
            <Text style={styles.cardDate}>{formatDate(item.created_at)}</Text>
          </View>
        </View>
      )}
      contentContainerStyle={{ paddingBottom: 30 }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '800', padding: 20, paddingBottom: 10 },
  empty: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#999', textAlign: 'center' },
  card: {
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#f9f9f9',
    borderWidth: 1,
    borderColor: '#eee',
  },
  image: { width: SCREEN_WIDTH - 40, height: (SCREEN_WIDTH - 40) * 1.333, backgroundColor: '#eee' },
  cardBody: { padding: 16 },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardCaption: { color: '#555', marginTop: 4, fontSize: 14 },
  cardDate: { color: '#999', marginTop: 8, fontSize: 12 },
});
