/** Files tab: folders and any kind of file, like a small Drive. */
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { UploadBanner } from '@/components/UploadBanner';
import { Button, EmptyState, IconButton, Loading, Screen, type IconName } from '@/components/ui';
import { api, thumbSource } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { actionSheet, confirm, errorText, prompt, toast } from '@/lib/dialogs';
import { formatBytes, formatDateTime } from '@/lib/format';
import * as haptics from '@/lib/haptics';
import {
  flatten,
  folderSource,
  invalidateAssets,
  invalidateFolders,
  useAssetList,
} from '@/lib/queries';
import { colors, font, radius, spacing } from '@/lib/theme';
import { canSaveToCameraRoll, openFile, saveToDevice, shareAsset } from '@/lib/transfer';
import type { Asset, Folder } from '@/lib/types';
import { pickAndUpload } from '@/lib/uploader';

type Entry = { type: 'folder'; folder: Folder } | { type: 'asset'; asset: Asset };

function fileIcon(asset: Asset): IconName {
  if (asset.kind === 'video') return 'videocam-outline';
  if (asset.kind === 'photo') return 'image-outline';
  if (asset.mime === 'application/pdf') return 'document-text-outline';
  if (asset.mime.startsWith('audio/')) return 'musical-notes-outline';
  if (asset.mime.includes('zip') || asset.mime.includes('compressed')) return 'archive-outline';
  if (asset.mime.startsWith('text/')) return 'document-text-outline';
  return 'document-outline';
}

export default function FilesScreen() {
  const session = useAuth((state) => state.session);
  // The trail of folders from the top level down to the one being shown.
  const [path, setPath] = useState<Folder[]>([]);
  const current = path.length ? path[path.length - 1] : null;
  const currentId = current?.id ?? null;

  const folders = useQuery({
    queryKey: ['folders', currentId ?? 'root'],
    queryFn: () => api.listFolders(currentId ?? 'root'),
  });
  const source = folderSource(currentId);
  const files = useAssetList(source);
  const assets = useMemo(() => flatten(files.data?.pages), [files.data]);

  const entries = useMemo<Entry[]>(
    () => [
      ...(folders.data ?? []).map((folder): Entry => ({ type: 'folder', folder })),
      ...assets.map((asset): Entry => ({ type: 'asset', asset })),
    ],
    [folders.data, assets],
  );

  const guard = async (action: () => Promise<string | void>) => {
    try {
      const message = await action();
      if (message) toast(message);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  };

  const newFolder = async () => {
    const name = await prompt({
      title: 'New folder',
      placeholder: 'Folder name',
      confirmLabel: 'Create',
    });
    if (!name) return;
    await guard(async () => {
      await api.createFolder(name, currentId);
      invalidateFolders();
      haptics.success();
    });
  };

  const openAsset = (asset: Asset) => {
    if (asset.kind === 'photo' || asset.kind === 'video') {
      router.push({ pathname: '/viewer/[id]', params: { id: asset.id, source } });
    } else {
      guard(() => openFile(asset));
    }
  };

  const chooseFolder = async (exclude: string | null): Promise<string | null | undefined> => {
    const all = await api.allFolders();
    const byId = new Map(all.map((folder) => [folder.id, folder]));
    const fullPath = (folder: Folder): string => {
      const names = [folder.name];
      let parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
      while (parent) {
        names.unshift(parent.name);
        parent = parent.parent_id ? byId.get(parent.parent_id) : undefined;
      }
      return names.join(' / ');
    };
    const options = [
      { key: 'root', label: 'Files (top level)', icon: 'home-outline' },
      ...all
        .filter((folder) => folder.id !== exclude)
        .map((folder) => ({ key: folder.id, label: fullPath(folder), icon: 'folder-outline' }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];
    const picked = await actionSheet({ title: 'Move to', options });
    if (picked === null) return undefined;
    return picked === 'root' ? null : picked;
  };

  const assetMenu = async (asset: Asset) => {
    haptics.tap();
    const choice = await actionSheet({
      title: asset.original_name,
      options: [
        { key: 'save', label: canSaveToCameraRoll && asset.kind !== 'file' ? 'Save to camera roll' : 'Download', icon: 'download-outline' },
        ...(canSaveToCameraRoll ? [{ key: 'share', label: 'Share', icon: 'share-outline' }] : []),
        { key: 'rename', label: 'Rename', icon: 'pencil-outline' },
        { key: 'move', label: 'Move', icon: 'folder-open-outline' },
        { key: 'delete', label: 'Move to trash', icon: 'trash-outline', destructive: true },
      ],
    });
    if (choice === 'save') await guard(() => saveToDevice(asset));
    if (choice === 'share') await guard(() => shareAsset(asset));
    if (choice === 'rename') {
      const name = await prompt({ title: 'Rename', initialValue: asset.original_name });
      if (name && name !== asset.original_name) {
        await guard(async () => {
          await api.patchAsset(asset.id, { original_name: name });
          invalidateAssets();
        });
      }
    }
    if (choice === 'move') {
      await guard(async () => {
        const target = await chooseFolder(null);
        if (target === undefined || target === asset.folder_id) return;
        await api.patchAsset(asset.id, { folder_id: target });
        invalidateAssets();
        return 'Moved';
      });
    }
    if (choice === 'delete') {
      const ok = await confirm({
        title: `Move "${asset.original_name}" to the trash?`,
        message: 'It stays in the trash for 30 days.',
        confirmLabel: 'Move to trash',
        destructive: true,
      });
      if (ok) {
        await guard(async () => {
          await api.deleteAsset(asset.id);
          invalidateAssets();
          return 'Moved to the trash';
        });
      }
    }
  };

  const folderMenu = async (folder: Folder) => {
    haptics.tap();
    const choice = await actionSheet({
      title: folder.name,
      options: [
        { key: 'rename', label: 'Rename', icon: 'pencil-outline' },
        { key: 'move', label: 'Move', icon: 'folder-open-outline' },
        { key: 'delete', label: 'Delete folder', icon: 'trash-outline', destructive: true },
      ],
    });
    if (choice === 'rename') {
      const name = await prompt({ title: 'Rename folder', initialValue: folder.name });
      if (name && name !== folder.name) {
        await guard(async () => {
          await api.patchFolder(folder.id, { name });
          invalidateFolders();
        });
      }
    }
    if (choice === 'move') {
      await guard(async () => {
        const target = await chooseFolder(folder.id);
        if (target === undefined || target === folder.parent_id) return;
        await api.patchFolder(folder.id, { parent_id: target });
        invalidateFolders();
        return 'Moved';
      });
    }
    if (choice === 'delete') {
      const ok = await confirm({
        title: `Delete "${folder.name}"?`,
        message: 'Files inside it move to the trash, where they stay for 30 days.',
        confirmLabel: 'Delete folder',
        destructive: true,
      });
      if (ok) {
        await guard(async () => {
          await api.deleteFolder(folder.id, true);
          invalidateFolders();
          invalidateAssets();
          return 'Folder deleted';
        });
      }
    }
  };

  const loading = folders.isPending || files.isPending;
  const failed = (folders.isError || files.isError) && !entries.length;

  return (
    <Screen
      title="Files"
      right={
        <>
          <IconButton icon="folder-open-outline" label="New folder" onPress={newFolder} testID="files-new-folder" />
          <IconButton
            icon="add-circle-outline"
            label="Upload files"
            size={26}
            onPress={() => pickAndUpload(currentId ?? 'root')}
            testID="files-upload"
          />
        </>
      }>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.crumbs}
        contentContainerStyle={styles.crumbsContent}>
        <Crumb label="Files" active={!path.length} onPress={() => setPath([])} testID="crumb-root" />
        {path.map((folder, i) => (
          <View key={folder.id} style={styles.crumbItem}>
            <Ionicons name="chevron-forward" size={14} color={colors.textFaint} />
            <Crumb
              label={folder.name}
              active={i === path.length - 1}
              onPress={() => setPath(path.slice(0, i + 1))}
            />
          </View>
        ))}
      </ScrollView>
      <UploadBanner />

      {loading ? (
        <Loading />
      ) : failed ? (
        <EmptyState
          icon="cloud-offline-outline"
          title="Can't reach your server"
          message={errorText(folders.error ?? files.error)}
          action={
            <Button
              label="Try again"
              variant="secondary"
              onPress={() => {
                folders.refetch();
                files.refetch();
              }}
            />
          }
        />
      ) : !entries.length ? (
        <EmptyState
          icon="folder-open-outline"
          title={current ? 'This folder is empty' : 'No files yet'}
          message="Upload documents, videos or anything else. They are stored on your Pi."
          action={<Button label="Upload files" icon="add" onPress={() => pickAndUpload(currentId ?? 'root')} />}
        />
      ) : (
        <FlatList
          testID="files-list"
          data={entries}
          keyExtractor={(entry) => (entry.type === 'folder' ? entry.folder.id : entry.asset.id)}
          contentContainerStyle={styles.listContent}
          onEndReached={() => {
            if (files.hasNextPage && !files.isFetchingNextPage) files.fetchNextPage();
          }}
          onEndReachedThreshold={1.5}
          refreshing={files.isRefetching && !files.isFetchingNextPage}
          onRefresh={() => {
            folders.refetch();
            files.refetch();
          }}
          renderItem={({ item }) =>
            item.type === 'folder' ? (
              <EntryRow
                testID={`folder-${item.folder.name}`}
                title={item.folder.name}
                subtitle="Folder"
                leading={<Ionicons name="folder" size={28} color={colors.accent} />}
                onPress={() => setPath([...path, item.folder])}
                onMenu={() => folderMenu(item.folder)}
              />
            ) : (
              <EntryRow
                testID={`file-${item.asset.original_name}`}
                title={item.asset.original_name}
                subtitle={`${formatBytes(item.asset.size_bytes)}  ·  ${formatDateTime(item.asset.created_at)}`}
                leading={
                  item.asset.kind !== 'file' && item.asset.status === 'ready' ? (
                    <Image
                      source={thumbSource(session, item.asset.id, 'thumb')}
                      style={styles.preview}
                      contentFit="cover"
                      recyclingKey={item.asset.id}
                    />
                  ) : (
                    <Ionicons name={fileIcon(item.asset)} size={26} color={colors.textDim} />
                  )
                }
                onPress={() => openAsset(item.asset)}
                onMenu={() => assetMenu(item.asset)}
              />
            )
          }
        />
      )}
    </Screen>
  );
}

function Crumb({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} testID={testID}>
      <Text style={[font.body, { color: active ? colors.text : colors.accent, fontWeight: active ? '600' : '400' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function EntryRow({
  title,
  subtitle,
  leading,
  onPress,
  onMenu,
  testID,
}: {
  title: string;
  subtitle: string;
  leading: React.ReactNode;
  onPress: () => void;
  onMenu: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.entry}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={onPress}
        onLongPress={onMenu}
        style={({ pressed }) => [styles.entryMain, pressed && { opacity: 0.6 }]}>
        <View style={styles.leading}>{leading}</View>
        <View style={styles.entryText}>
          <Text style={font.body} numberOfLines={1}>
            {title}
          </Text>
          <Text style={font.small} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <IconButton
        icon="ellipsis-horizontal"
        label={`More actions for ${title}`}
        color={colors.textDim}
        size={20}
        onPress={onMenu}
        testID={testID ? `${testID}-menu` : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  crumbs: { flexGrow: 0, marginBottom: spacing.md },
  crumbsContent: { paddingHorizontal: spacing.lg, alignItems: 'center', gap: spacing.xs },
  crumbItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64 },
  leading: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  preview: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.surface },
  entryText: { flex: 1, gap: 2 },
});
